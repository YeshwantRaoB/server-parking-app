const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { ClerkExpressRequireAuth, clerkClient } = require('@clerk/clerk-sdk-node');
const { Expo } = require('expo-server-sdk');
const XLSX = require('xlsx');
require('dotenv').config();
//using express
const app = express();

// CORS Configuration
const allowedOrigins = [
  'http://localhost:19006', // Expo development
  'http://localhost:3000',  // Local development
  'https://college-parking-app.vercel.app', // Your Vercel frontend URL
  /.*\.vercel\.app$/, // Allow all Vercel preview deployments
];

// CORS middleware - permissive for mobile apps
app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  // For Expo/React Native apps, origin might be null or undefined
  // Allow requests without origin (mobile apps) or from allowed origins
  if (!origin || allowedOrigins.some(allowedOrigin => 
    typeof allowedOrigin === 'string' 
      ? origin === allowedOrigin 
      : allowedOrigin.test(origin)
  )) {
    res.header('Access-Control-Allow-Origin', origin || '*');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Requested-With');
    res.header('Access-Control-Max-Age', '86400'); // 24 hours
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }
  }
  next();
});

// Body parser middleware
app.use(express.json({ limit: '10mb' }));

// Clerk middleware to verify JWT tokens
const requireAuth = (req, res, next) => {
  return ClerkExpressRequireAuth({
    onError: (err) => {
      console.error('Auth error:', err);
      return res.status(401).json({ error: 'Unauthorized' });
    },
  })(req, res, next);
};

// Admin middleware to check if user has admin role
const requireAdmin = [
  requireAuth,
  async (req, res, next) => {
    try {
      // Debug: Log the entire auth object to see what's available
      console.log('Auth userId:', req.auth.userId);
      console.log('Session claims:', JSON.stringify(req.auth.sessionClaims, null, 2));
      
      // Try to get role from session claims first
      let userRole = req.auth.sessionClaims?.metadata?.role || 
                     req.auth.sessionClaims?.publicMetadata?.role ||
                     req.auth.sessionClaims?.public_metadata?.role;
      
      // If not found in session claims, fetch from Clerk API
      if (!userRole) {
        console.log('Role not found in session claims, fetching from Clerk API...');
        const user = await clerkClient.users.getUser(req.auth.userId);
        userRole = user.publicMetadata?.role;
        console.log('Role from Clerk API:', userRole);
      }
      
      console.log('Final extracted user role:', userRole);
      
      if (userRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
      }
      next();
    } catch (error) {
      console.error('Error checking admin role:', error);
      return res.status(500).json({ error: 'Failed to verify admin role' });
    }
  }
];

// Whitelist check middleware - Verify email is authorized for KPT Mangalore
const checkWhitelist = async (req, res, next) => {
  try {
    await connectDB();
    
    // Get user's email from Clerk
    const user = await clerkClient.users.getUser(req.auth.userId);
    const userEmail = user.emailAddresses[0]?.emailAddress;
    
    if (!userEmail) {
      return res.status(403).json({ 
        error: 'No email found for user',
        kptError: true,
        message: 'This user is not part of KPT Mangalore. Please contact the admin.'
      });
    }
    
    console.log('Checking whitelist for email:', userEmail);
    
    // Check if email is in whitelist
    const whitelistEntry = await Whitelist.findOne({ 
      email: userEmail.toLowerCase() 
    });
    
    if (!whitelistEntry) {
      console.log('Email not in whitelist:', userEmail);
      return res.status(403).json({ 
        error: 'Unauthorized access',
        kptError: true,
        message: 'This user is not part of KPT Mangalore. Please contact the admin to get your email added to the authorized list.'
      });
    }
    
    // Update status to registered if it was pending
    if (whitelistEntry.status === 'pending' && !whitelistEntry.clerkId) {
      whitelistEntry.status = 'registered';
      whitelistEntry.clerkId = req.auth.userId;
      await whitelistEntry.save();
      console.log('Updated whitelist entry status to registered');
    }
    
    // Store whitelist info in request for later use
    req.whitelist = whitelistEntry;
    
    next();
  } catch (error) {
    console.error('Whitelist check error:', error);
    return res.status(500).json({ 
      error: 'Failed to verify authorization',
      message: 'An error occurred while checking authorization. Please try again.'
    });
  }
};

// Combined auth middleware: requireAuth + whitelist check
const requireAuthWithWhitelist = [requireAuth, checkWhitelist];

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// MongoDB connection function for serverless
const connectDB = async () => {
  if (mongoose.connection.readyState >= 1) return;
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB connected');
  } catch (err) {
    console.error('MongoDB connection error:', err);
    throw err;
  }
};

// Multer setup for file uploads (use /tmp for Vercel)
const upload = multer({
  dest: '/tmp/',
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Allow only image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Vehicle schema and model
const vehicleSchema = new mongoose.Schema({
  licencePlate: { type: String, required: true, unique: true },
  fullName: { type: String, required: true },
  branch: { type: String, required: true },
  designation: { type: String, required: true },
  registerNumber: { type: String }, // For students only
  department: { type: String }, // For staff only
  staffPosition: { type: String }, // Alternative field for staff position
  vehicleType: { type: String, required: true }, // 2 Wheeler or 4 Wheeler
  vehicleName: { type: String, required: true }, // Vehicle name/model
  vehiclePhotoUrl: { type: String, required: true }, // Vehicle photo
  ownerPhotoUrl: { type: String, required: true }, // Owner photo
  drivingLicensePhotoUrl: { type: String, required: true }, // Driving license photo
  phoneNumber: { 
    type: String, 
    required: true,
    validate: {
      validator: function(v) {
        // Indian mobile number validation: starts with 6-9, followed by 9 digits
        return /^[6-9]\d{9}$/.test(v);
      },
      message: 'Phone number must be a valid Indian mobile number (10 digits starting with 6-9)'
    }
  }, // Owner phone number
  userId: { type: String, required: true }, // Clerk user ID
  registeredBy: { type: String }, // 'user' or 'admin' - who registered this vehicle
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Vehicle = mongoose.model('Vehicle', vehicleSchema);

// User schema for storing push tokens and other user data
const userSchema = new mongoose.Schema({
  clerkId: { type: String, required: true, unique: true },
  pushToken: { type: String }, // Expo push token
  fcmToken: { type: String }, // Firebase Cloud Messaging token
  platform: { type: String }, // 'ios' or 'android'
  isAdmin: { type: Boolean, default: false }, // Admin flag for notifications
  role: { type: String, default: 'user' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Email Whitelist Schema for managing authorized users
const whitelistSchema = new mongoose.Schema({
  email: { 
    type: String, 
    required: true, 
    unique: true,
    lowercase: true,
    trim: true,
    validate: {
      validator: function(v) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
      },
      message: 'Please provide a valid email address'
    }
  },
  userType: { 
    type: String, 
    enum: ['Student', 'Staff'], 
    required: true 
  },
  branch: { type: String }, // For students
  department: { type: String }, // For staff
  addedBy: { type: String, required: true }, // Clerk ID of admin who added
  status: { 
    type: String, 
    enum: ['pending', 'registered', 'rejected'], 
    default: 'pending' 
  },
  clerkId: { type: String }, // Set when user actually signs up
  notes: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Create index for faster lookups
whitelistSchema.index({ email: 1, status: 1 });

const Whitelist = mongoose.model('Whitelist', whitelistSchema);

// Import Firebase Admin SDK for FCM
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK if credentials are available
let firebaseAdmin = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    firebaseAdmin = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin SDK initialized successfully');
  } else {
    console.warn('FIREBASE_SERVICE_ACCOUNT_KEY not found. FCM notifications will not work.');
  }
} catch (error) {
  console.error('Failed to initialize Firebase Admin SDK:', error.message);
}

// Notification helper function - supports both Expo and FCM tokens
const sendPushNotification = async (token, title, body, data = {}, platform = 'expo') => {
  try {
    // If it's an FCM token, use Firebase Admin SDK
    if (platform === 'fcm' && firebaseAdmin) {
      const message = {
        notification: {
          title,
          body,
        },
        data: {
          ...data,
          title, // Include title in data for custom handling
          body,  // Include body in data for custom handling
        },
        token: token,
        android: {
          priority: 'high',
          notification: {
            sound: 'default',
            channelId: 'default',
          },
        },
      };

      const response = await admin.messaging().send(message);
      console.log('FCM notification sent successfully:', response);
      return { success: true, response };
    }
    
    // Otherwise, use Expo push notifications
    if (!Expo.isExpoPushToken(token)) {
      console.error(`Token ${token} is not a valid Expo push token`);
      return { success: false, error: 'Invalid Expo token' };
    }

    const expo = new Expo();
    const message = {
      to: token,
      title,
      body,
      data,
      sound: 'default',
      priority: 'default',
    };

    const ticket = await expo.sendPushNotificationsAsync([message]);
    console.log('Expo notification sent:', ticket);
    return { success: true, ticket };
  } catch (error) {
    console.error('Error sending notification:', error);
    return { success: false, error: error.message };
  }
};

// Register push token endpoint (protected)
app.post('/register-push-token', requireAuth, async (req, res) => {
  try {
    await connectDB();
    const { pushToken, fcmToken, platform } = req.body;

    if (!pushToken && !fcmToken) {
      return res.status(400).json({ error: 'At least one push token is required' });
    }

    console.log('Registering push tokens for user:', req.auth.userId);
    console.log('Expo token:', pushToken);
    console.log('FCM token:', fcmToken);
    console.log('Platform:', platform);

    // Get user role from Clerk to determine if admin
    let isAdmin = false;
    try {
      const clerkUser = await clerkClient.users.getUser(req.auth.userId);
      isAdmin = clerkUser.publicMetadata?.role === 'admin';
      console.log('User is admin:', isAdmin);
    } catch (error) {
      console.error('Error fetching user from Clerk:', error);
    }

    // Upsert user with push tokens
    const updateData = {
      updatedAt: new Date(),
      isAdmin,
    };
    
    if (pushToken) updateData.pushToken = pushToken;
    if (fcmToken) updateData.fcmToken = fcmToken;
    if (platform) updateData.platform = platform;

    const user = await User.findOneAndUpdate(
      { clerkId: req.auth.userId },
      updateData,
      { upsert: true, new: true }
    );

    console.log('User tokens registered:', user);
    res.json({ success: true, message: 'Push tokens registered successfully', isAdmin });
  } catch (error) {
    console.error('Push token registration error:', error);
    res.status(500).json({ error: 'Failed to register push token' });
  }
});

// Upload image endpoint (protected)
app.post('/upload-image', requireAuth, upload.single('image'), async (req, res) => {
  try {
    console.log('Upload request received');
    console.log('Request headers:', req.headers);
    console.log('File received:', req.file ? 'Yes' : 'No');

    if (!req.file) {
      console.log('No file in request');
      return res.status(400).json({ error: 'No image file provided' });
    }

    console.log('Uploading image to Cloudinary:', req.file.path);
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'parking-app',
      resource_type: 'image',
      quality: 'auto',
      format: 'jpg'
    });

    console.log('Cloudinary upload successful:', result.secure_url);
    res.json({ url: result.secure_url });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload image: ' + error.message });
  }
});

// Register vehicle endpoint (protected with whitelist check)
app.post('/register', requireAuthWithWhitelist, async (req, res) => {
  console.log('\n=== New Registration Request ===');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Auth:', JSON.stringify(req.auth || {}, null, 2));
  
  try {
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    
    // Validate required fields
    const requiredFields = [
      'licencePlate', 'fullName', 'branch', 'designation', 
      'vehicleName', 'vehicleType', 'vehiclePhotoUrl', 'ownerPhotoUrl', 
      'drivingLicensePhotoUrl', 'phoneNumber'
    ];
    
    const missingFields = requiredFields.filter(field => !req.body[field]);
    if (missingFields.length > 0) {
      const errorMsg = `Missing required fields: ${missingFields.join(', ')}`;
      console.error('Validation error:', errorMsg);
      return res.status(400).json({ 
        success: false,
        error: errorMsg,
        missingFields
      });
    }

    const {
      licencePlate,
      fullName,
      branch,
      designation,
      registerNumber,
      department,
      staffPosition,
      vehicleName,
      vehicleType,
      vehiclePhotoUrl,
      ownerPhotoUrl,
      drivingLicensePhotoUrl,
      phoneNumber,
      userId = req.auth?.userId, // Fallback to auth userId if not in body
      registeredBy = 'user' // Track who registered this vehicle
    } = req.body;

    // Validate phone number format (Indian mobile number)
    if (!/^[6-9]\d{9}$/.test(phoneNumber)) {
      const errorMsg = 'Invalid phone number. Please enter a valid 10-digit Indian mobile number starting with 6, 7, 8, or 9';
      console.error('Validation error:', errorMsg);
      return res.status(400).json({ 
        success: false,
        error: errorMsg
      });
    }

    // Validate conditional fields
    if (designation === 'Student' && !registerNumber) {
      const errorMsg = 'Register number is required for students';
      console.error('Validation error:', errorMsg);
      return res.status(400).json({ 
        success: false,
        error: errorMsg
      });
    }

    const staffDept = department || staffPosition; // Handle both department and staffPosition
    if (designation === 'Staff' && !staffDept) {
      const errorMsg = 'Department/Position is required for staff';
      console.error('Validation error:', errorMsg);
      return res.status(400).json({ 
        success: false,
        error: errorMsg
      });
    }

    // Normalize license plate (uppercase, remove spaces)
    const normalizedPlate = licencePlate.toUpperCase().replace(/\s+/g, '');
    
    console.log('Connecting to database...');
    await connectDB();
    
    // Check if vehicle with this plate already exists
    console.log('Checking for existing vehicle with plate:', normalizedPlate);
    const existingVehicle = await Vehicle.findOne({ 
      licencePlate: { $regex: new RegExp(`^${normalizedPlate}$`, 'i') }
    });
    
    if (existingVehicle) {
      const errorMsg = 'Vehicle with this license plate already registered';
      console.error('Validation error:', errorMsg);
      return res.status(400).json({ 
        success: false,
        error: errorMsg
      });
    }

    console.log('Creating new vehicle record...');

    try {
      const vehicleData = {
        licencePlate: normalizedPlate, 
        fullName: fullName.trim(), 
        branch: branch.trim(), 
        designation: designation.trim(),
        registerNumber: designation === 'Student' ? registerNumber?.trim() : null,
        department: staffDept?.trim() || null,
        staffPosition: staffPosition?.trim() || null,
        vehicleName: vehicleName.trim(),
        vehicleType: vehicleType.trim(),
        vehiclePhotoUrl,
        ownerPhotoUrl,
        drivingLicensePhotoUrl,
        phoneNumber: phoneNumber.trim(),
        userId,
        registeredBy
      };

      console.log('Vehicle data to save:', JSON.stringify(vehicleData, null, 2));
      
      const vehicle = new Vehicle(vehicleData);
      const savedVehicle = await vehicle.save();
      console.log('Vehicle saved successfully:', savedVehicle);

      // Send push notification to admins
      try {
        console.log('Sending notifications to admins...');
        const admins = await User.find({ isAdmin: true });
        console.log(`Found ${admins.length} admins to notify`);
        
        const notificationPromises = admins.map(admin => {
          // Try FCM token first, then fall back to Expo token
          if (admin.fcmToken) {
            console.log(`Sending FCM notification to admin: ${admin.clerkId}`);
            return sendPushNotification(
              admin.fcmToken,
              'New Vehicle Registered',
              `${fullName} has registered their vehicle (${normalizedPlate})`,
              { 
                screen: 'Admin',
                vehicleId: savedVehicle._id.toString(),
                type: 'vehicle_registration'
              },
              'fcm'
            ).catch(e => {
              console.error(`Failed to send FCM notification to admin ${admin.clerkId}:`, e);
              return null;
            });
          } else if (admin.pushToken) {
            console.log(`Sending Expo notification to admin: ${admin.clerkId}`);
            return sendPushNotification(
              admin.pushToken,
              'New Vehicle Registered',
              `${fullName} has registered their vehicle (${normalizedPlate})`,
              { 
                screen: 'Admin',
                vehicleId: savedVehicle._id.toString(),
                type: 'vehicle_registration'
              },
              'expo'
            ).catch(e => {
              console.error(`Failed to send Expo notification to admin ${admin.clerkId}:`, e);
              return null;
            });
          } else {
            console.log(`Admin ${admin.clerkId} has no push tokens registered`);
            return Promise.resolve();
          }
        });

        await Promise.all(notificationPromises);
        console.log('All admin notifications sent');
      } catch (notificationError) {
        console.error('Error in notification process:', notificationError);
        // Don't fail the request if notifications fail
      }

      console.log('Vehicle registration completed successfully');
      return res.status(201).json({ 
        success: true, 
        message: 'Vehicle registered successfully',
        vehicle: savedVehicle,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error saving vehicle:', {
        message: error.message,
        stack: error.stack,
        name: error.name,
        ...(error.code && { code: error.code }),
        ...(error.keyPattern && { keyPattern: error.keyPattern }),
        ...(error.keyValue && { keyValue: error.keyValue })
      });
      
      // Handle duplicate key errors
      if (error.code === 11000) {
        const field = Object.keys(error.keyPattern)[0];
        const value = error.keyValue[field];
        return res.status(409).json({
          success: false,
          error: `${field} '${value}' is already registered`,
          field,
          value,
          code: 'DUPLICATE_KEY'
        });
      }
      
      // Handle validation errors
      if (error.name === 'ValidationError') {
        const errors = Object.values(error.errors).map(err => ({
          field: err.path,
          message: err.message,
          type: err.kind
        }));
        
        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: errors,
          code: 'VALIDATION_ERROR'
        });
      }
      
      // Generic error response
      return res.status(500).json({ 
        success: false,
        error: 'Internal server error during registration',
        message: process.env.NODE_ENV === 'production' 
          ? 'An error occurred while processing your request' 
          : error.message,
        code: 'INTERNAL_SERVER_ERROR',
        ...(process.env.NODE_ENV !== 'production' && { stack: error.stack })
      });
    }
  } catch (error) {
    console.error('Registration error:', {
      message: error.message,
      stack: error.stack,
      name: error.name,
      ...(error.code && { code: error.code })
    });
    
    res.status(500).json({
      success: false,
      error: 'An unexpected error occurred',
      message: error.message,
      code: 'INTERNAL_SERVER_ERROR',
      ...(process.env.NODE_ENV !== 'production' && { stack: error.stack })
    });
  }
});

// Get user's own vehicles endpoint (protected with whitelist check)
app.get('/my-vehicles', requireAuthWithWhitelist, async (req, res) => {
  try {
    await connectDB();
    const vehicles = await Vehicle.find({ userId: req.auth.userId })
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    res.json({
      success: true,
      vehicles
    });
  } catch (err) {
    console.error('Error fetching user vehicles:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch vehicles' });
  }
});

// Update user's own vehicle endpoint (protected with whitelist check)
app.patch('/my-vehicles/:id', requireAuthWithWhitelist, async (req, res) => {
  try {
    await connectDB();
    const { licencePlate, phoneNumber, ...updateData } = req.body;

    // Validate phone number if provided
    if (phoneNumber && !/^[6-9]\d{9}$/.test(phoneNumber)) {
      return res.status(400).json({ 
        error: 'Invalid phone number. Please enter a valid 10-digit Indian mobile number starting with 6, 7, 8, or 9' 
      });
    }
    
    // Check if vehicle belongs to user
    const vehicle = await Vehicle.findOne({ _id: req.params.id, userId: req.auth.userId });
    if (!vehicle) {
      return res.status(404).json({ error: 'Vehicle not found or access denied' });
    }
    
    // If updating license plate, check for duplicates
    if (licencePlate && licencePlate !== vehicle.licencePlate) {
      const existing = await Vehicle.findOne({ licencePlate });
      if (existing) {
        return res.status(400).json({ error: 'Another vehicle with this license plate already exists' });
      }
      updateData.licencePlate = licencePlate;
    }

    // If updating phone number, include it in update data
    if (phoneNumber) {
      updateData.phoneNumber = phoneNumber.trim();
    }

    updateData.updatedAt = new Date();

    const updatedVehicle = await Vehicle.findByIdAndUpdate(
      req.params.id, 
      updateData,
      {
        new: true,
        runValidators: true,
      }
    );

    res.json({ 
      success: true, 
      message: 'Vehicle updated successfully', 
      vehicle: updatedVehicle 
    });
  } catch (error) {
    console.error('Update error:', error);
    res.status(500).json({ error: 'Failed to update vehicle' });
  }
});

// Search vehicles endpoint (protected, admin only)
app.get('/vehicles', requireAdmin, async (req, res) => {
  try {
    await connectDB();
    let { licencePlate, page = 1, limit = 10, sortBy = 'licencePlate' } = req.query;

    page = parseInt(page);
    limit = parseInt(limit);
    if (isNaN(page) || page < 1) page = 1;
    if (isNaN(limit) || limit < 1 || limit > 100) limit = 10;

    const query = {};

    if (licencePlate) {
      query.licencePlate = { $regex: licencePlate, $options: 'i' }; // case-insensitive regex match
    }

    // Validate sortBy field - allow only certain fields
    const allowedSortFields = ['licencePlate', 'fullName', 'branch', 'createdAt'];
    if (!allowedSortFields.includes(sortBy)) {
      sortBy = 'licencePlate';
    }

    // Count total records for pagination
    const totalRecords = await Vehicle.countDocuments(query);

    // Query vehicles with pagination and sorting
    const vehicles = await Vehicle.find(query)
      .sort({ [sortBy]: 1 }) // ascending sort
      .skip((page - 1) * limit)
      .limit(limit)
      .lean()
      .exec();

    res.json({
      success: true,
      page,
      limit,
      totalRecords,
      totalPages: Math.ceil(totalRecords / limit),
      vehicles
    });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ success: false, error: 'Failed to search vehicles' });
  }
});

// License plate scanning endpoint with Plate Recognizer API (protected)
app.post('/scan-plate', requireAuth, upload.single('image'), async (req, res) => {
  try {
    console.log('\n=== Plate Scanning Request ===');
    console.log('File received:', req.file ? 'Yes' : 'No');
    
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        error: 'No image file provided',
        plateDetected: false
      });
    }

    console.log('File details:', {
      filename: req.file.filename,
      size: req.file.size,
      mimetype: req.file.mimetype
    });

    // Prepare form data for Plate Recognizer API
    const FormData = require('form-data');
    const fs = require('fs');
    const https = require('https');
    
    const formData = new FormData();
    formData.append('upload', fs.createReadStream(req.file.path));
    
    // Add regions for better accuracy - India uses 'in'
    // Note: We're not using strict mode to allow for variations in plate formats
    formData.append('regions', 'in');
    
    // Add configuration for better detection
    // Using 'normal' mode instead of 'strict' to handle format variations
    formData.append('config', JSON.stringify({
      mode: 'fast'       // Use fast mode for quicker results
    }));
    
    console.log('Sending image to Plate Recognizer API with region: in');
    
    // Make request to Plate Recognizer API
    const options = {
      method: 'POST',
      hostname: 'api.platerecognizer.com',
      path: '/v1/plate-reader/',
      headers: {
        'Authorization': 'Token 9836f8ce1925afcbbb121dc58280a9bd4b8a6174',
        ...formData.getHeaders()
      }
    };

    const apiRequest = new Promise((resolve, reject) => {
      const apiReq = https.request(options, (apiRes) => {
        let data = '';
        
        console.log('Plate Recognizer API status:', apiRes.statusCode);
        
        apiRes.on('data', (chunk) => {
          data += chunk;
        });
        
        apiRes.on('end', () => {
          try {
            const parsedData = JSON.parse(data);
            
            // Check for API errors
            if (apiRes.statusCode !== 200 && apiRes.statusCode !== 201) {
              reject(new Error(parsedData.error || `API returned status ${apiRes.statusCode}`));
            } else {
              resolve(parsedData);
            }
          } catch (e) {
            console.error('Failed to parse API response:', data);
            reject(new Error('Failed to parse API response'));
          }
        });
      });
      
      apiReq.on('error', (error) => {
        console.error('HTTPS request error:', error);
        reject(error);
      });
      
      formData.pipe(apiReq);
    });

    const plateData = await apiRequest;
    console.log('Plate Recognizer full response:', JSON.stringify(plateData, null, 2));

    // Clean up the uploaded file
    try {
      fs.unlinkSync(req.file.path);
    } catch (cleanupError) {
      console.error('Error cleaning up file:', cleanupError);
    }

    // Check if any plates were detected
    if (!plateData.results || plateData.results.length === 0) {
      console.log('No plates detected in image');
      console.log('API response:', JSON.stringify(plateData, null, 2));
      return res.json({
        success: true,
        found: false,
        message: 'No license plate detected in the image. Please ensure the plate is clearly visible, well-lit, and not obscured. Try taking the photo from a closer distance.',
        plateDetected: false,
        apiResponse: {
          processing_time: plateData.processing_time,
          filename: plateData.filename
        }
      });
    }

    // Get the best plate match (highest confidence score)
    const bestResult = plateData.results[0];
    console.log('Best plate result:', bestResult);
    
    // Extract plate text - handle both old and new API response formats
    let plateText = '';
    if (typeof bestResult.plate === 'string') {
      plateText = bestResult.plate;
    } else if (bestResult.plate && bestResult.plate.props && bestResult.plate.props.plate) {
      plateText = bestResult.plate.props.plate[0].value;
    }
    
    if (!plateText) {
      console.error('Could not extract plate text from result:', bestResult);
      return res.json({
        success: true,
        found: false,
        message: 'Plate detection failed. Please try again.',
        plateDetected: false
      });
    }
    
    const detectedPlate = plateText.toUpperCase().replace(/\s+/g, '');
    const confidence = bestResult.score || (bestResult.plate && bestResult.plate.score) || 0;
    
    console.log('Detected plate:', detectedPlate, 'Confidence:', confidence);

    // Check confidence threshold (lowered to 0.3 to catch more plates)
    // Plate Recognizer recommends 0.7 for high confidence, but we'll be more lenient
    if (confidence < 0.3) {
      console.log('Low confidence detection:', confidence);
      return res.json({
        success: true,
        found: false,
        plateDetected: true,
        detectedPlate: detectedPlate,
        confidence: confidence,
        message: `Low confidence detection (${Math.round(confidence * 100)}%). Please try again with better lighting and angle.`
      });
    } else if (confidence < 0.5) {
      console.log('Medium confidence detection:', confidence, '- proceeding with search');
    }

    // Search database for the detected plate
    await connectDB();
    
    console.log('Searching database for plate:', detectedPlate);
    
    // Try exact match first (case-insensitive)
    let vehicle = await Vehicle.findOne({ 
      licencePlate: { $regex: new RegExp(`^${detectedPlate}$`, 'i') }
    }).lean().exec();

    // If no exact match, try fuzzy search (similar plates)
    if (!vehicle) {
      console.log('No exact match, trying fuzzy search...');
      const allVehicles = await Vehicle.find().lean().exec();
      
      // Try to find a close match
      for (const v of allVehicles) {
        const storedPlate = v.licencePlate.toUpperCase().replace(/\s+/g, '');
        
        // Check if plates are similar (allowing for 1-2 character differences)
        if (storedPlate.includes(detectedPlate) || detectedPlate.includes(storedPlate)) {
          vehicle = v;
          console.log('Found similar plate:', storedPlate, 'for detected:', detectedPlate);
          break;
        }
      }
    }

    if (vehicle) {
      console.log('Vehicle found in database:', vehicle.licencePlate);
      return res.json({
        success: true,
        found: true,
        plateDetected: true,
        detectedPlate: detectedPlate,
        confidence: confidence,
        vehicle,
        matchType: vehicle.licencePlate.toUpperCase().replace(/\s+/g, '') === detectedPlate ? 'exact' : 'fuzzy'
      });
    } else {
      console.log('Vehicle not found in database');
      console.log('Detected plate:', detectedPlate);
      console.log('Available plates in database:');
      const allPlates = await Vehicle.find().select('licencePlate').lean().exec();
      console.log(allPlates.map(v => v.licencePlate).join(', '));
      
      return res.json({
        success: true,
        found: false,
        plateDetected: true,
        detectedPlate: detectedPlate,
        confidence: confidence,
        message: 'Vehicle not registered in the system'
      });
    }

  } catch (error) {
    console.error('Plate scanning error:', error);
    
    // Clean up file if it exists
    if (req.file && req.file.path) {
      try {
        const fs = require('fs');
        fs.unlinkSync(req.file.path);
      } catch (cleanupError) {
        console.error('Error cleaning up file:', cleanupError);
      }
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Failed to scan license plate',
      message: error.message 
    });
  }
});

// License plate lookup endpoint (protected, admin only) - Optimized for scanning
app.get('/vehicles/lookup/:licensePlate', requireAdmin, async (req, res) => {
  try {
    await connectDB();
    const { licensePlate } = req.params;
    
    if (!licensePlate) {
      return res.status(400).json({ success: false, error: 'License plate is required' });
    }

    // Normalize the license plate for search (remove spaces, convert to uppercase)
    const normalizedPlate = licensePlate.toUpperCase().replace(/\s+/g, '');
    
    // Search for exact match first, then fuzzy match
    let vehicle = await Vehicle.findOne({ 
      licencePlate: normalizedPlate 
    }).lean().exec();

    // If no exact match, try fuzzy search
    if (!vehicle) {
      vehicle = await Vehicle.findOne({ 
        licencePlate: { $regex: normalizedPlate, $options: 'i' }
      }).lean().exec();
    }

    if (vehicle) {
      res.json({
        success: true,
        found: true,
        vehicle
      });
    } else {
      res.json({
        success: true,
        found: false,
        message: 'Vehicle not found'
      });
    }
  } catch (err) {
    console.error('License plate lookup error:', err);
    res.status(500).json({ success: false, error: 'Failed to lookup license plate' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Debug endpoint to check token contents (protected)
app.get('/debug-token', requireAuth, async (req, res) => {
  try {
    // Get user from Clerk API to see current metadata
    const user = await clerkClient.users.getUser(req.auth.userId);
    
    res.json({
      userId: req.auth.userId,
      sessionClaims: req.auth.sessionClaims,
      userFromClerk: {
        id: user.id,
        emailAddresses: user.emailAddresses,
        publicMetadata: user.publicMetadata,
        privateMetadata: user.privateMetadata,
      },
      auth: req.auth,
    });
  } catch (error) {
    res.json({
      userId: req.auth.userId,
      sessionClaims: req.auth.sessionClaims,
      auth: req.auth,
      error: error.message,
    });
  }
});

// Delete a vehicle by ID (admin only)
app.delete('/vehicles/:id', requireAdmin, async (req, res) => {
  try {
    await connectDB();
    const deletedVehicle = await Vehicle.findByIdAndDelete(req.params.id);
    if (!deletedVehicle) {
      return res.status(404).json({ error: 'Vehicle not found' });
    }
    res.json({ success: true, message: 'Vehicle deleted successfully' });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Failed to delete vehicle' });
  }
});

// Add admin endpoint (admin only)
app.post('/add-admin', requireAdmin, async (req, res) => {
  try {
    await connectDB();
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Find user by email in Clerk
    const users = await clerkClient.users.getUserList({
      emailAddress: [email]
    });

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found with this email address' });
    }

    const user = users[0];

    // Update user's public metadata to include admin role
    await clerkClient.users.updateUserMetadata(user.id, {
      publicMetadata: {
        ...user.publicMetadata,
        role: 'admin'
      }
    });

    // Also update our local User model
    await User.findOneAndUpdate(
      { clerkId: user.id },
      { role: 'admin', updatedAt: new Date() },
      { upsert: true }
    );

    console.log(`Admin role granted to user: ${email} (${user.id})`);

    res.json({
      success: true,
      message: `Admin privileges granted to ${email}. They will need to sign out and sign back in for changes to take effect.`
    });
  } catch (error) {
    console.error('Add admin error:', error);
    res.status(500).json({ error: 'Failed to add admin: ' + error.message });
  }
});

// Get vehicle statistics endpoint (admin only)
app.get('/vehicles/stats', requireAdmin, async (req, res) => {
  try {
    await connectDB();
    // Total vehicle count
    const total = await Vehicle.countDocuments({});
    
    // Designation breakdown
    const designations = await Vehicle.aggregate([
      { $group: { _id: '$designation', count: { $sum: 1 } } },
      { $sort: { _id: 1 } } // Sort alphabetically
    ]);
    
    // Student branch breakdown
    const branches = await Vehicle.aggregate([
      { $match: { designation: 'Student' } },
      { $group: { _id: '$branch', count: { $sum: 1 } } },
      { $sort: { count: -1 } } // Sort by count descending
    ]);
    
    // Staff position breakdown (using department field from backend)
    const staffPositions = await Vehicle.aggregate([
      { $match: { designation: 'Staff' } },
      { $group: { _id: '$department', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    
    // Recent registrations (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const recentCount = await Vehicle.countDocuments({
      createdAt: { $gte: thirtyDaysAgo }
    });
    
    // Monthly registration trend (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    
    const monthlyTrend = await Vehicle.aggregate([
      { $match: { createdAt: { $gte: sixMonthsAgo } } },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } }
    ]);

    res.json({
      success: true,
      total,
      designations: designations.map(d => ({ designation: d._id, count: d.count })),
      branches: branches.map(b => ({ branch: b._id, count: b.count })),
      staffPositions: staffPositions.map(s => ({ position: s._id, count: s.count })),
      recentCount,
      monthlyTrend: monthlyTrend.map(m => ({
        month: `${m._id.year}-${String(m._id.month).padStart(2, '0')}`,
        count: m.count
      }))
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch statistics' });
  }
});

// Get detailed statistics combining whitelist and vehicle data (admin only)
app.get('/statistics/detailed', requireAdmin, async (req, res) => {
  try {
    await connectDB();
    
    // ===== WHITELIST STATISTICS =====
    const whitelistStats = {
      total: await Whitelist.countDocuments({}),
      registered: await Whitelist.countDocuments({ status: 'registered' }),
      pending: await Whitelist.countDocuments({ status: 'pending' }),
      students: await Whitelist.countDocuments({ userType: 'Student' }),
      staff: await Whitelist.countDocuments({ userType: 'Staff' })
    };
    
    // Student distribution by branch (from whitelist)
    const whitelistBranches = await Whitelist.aggregate([
      { $match: { userType: 'Student' } },
      { $group: { _id: '$branch', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    
    // Staff distribution by department (from whitelist)
    const whitelistDepartments = await Whitelist.aggregate([
      { $match: { userType: 'Staff' } },
      { $group: { _id: '$department', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    
    // ===== VEHICLE STATISTICS =====
    const vehicleStats = {
      total: await Vehicle.countDocuments({}),
      students: await Vehicle.countDocuments({ designation: 'Student' }),
      staff: await Vehicle.countDocuments({ designation: 'Staff' }),
      twoWheelers: await Vehicle.countDocuments({ vehicleType: '2 Wheeler' }),
      fourWheelers: await Vehicle.countDocuments({ vehicleType: '4 Wheeler' })
    };
    
    // Student vehicles by branch
    const vehicleBranches = await Vehicle.aggregate([
      { $match: { designation: 'Student' } },
      { $group: { _id: '$branch', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    
    // Staff vehicles by department
    const vehicleDepartments = await Vehicle.aggregate([
      { $match: { designation: 'Staff' } },
      { $group: { _id: '$department', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    
    // Recent registrations (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const recentVehicles = await Vehicle.countDocuments({
      createdAt: { $gte: thirtyDaysAgo }
    });
    
    // Monthly vehicle registration trend (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    
    const monthlyTrend = await Vehicle.aggregate([
      { $match: { createdAt: { $gte: sixMonthsAgo } } },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } }
    ]);
    
    // ===== COMBINED STATISTICS =====
    // Calculate registration rate (users with vehicles vs total users)
    const registrationRate = whitelistStats.registered > 0 
      ? ((vehicleStats.total / whitelistStats.registered) * 100).toFixed(1)
      : '0.0';
    
    // Department-wise detailed breakdown for staff
    const departmentDetails = await Vehicle.aggregate([
      { $match: { designation: 'Staff' } },
      {
        $group: {
          _id: '$department',
          vehicleCount: { $sum: 1 },
          twoWheelers: {
            $sum: { $cond: [{ $eq: ['$vehicleType', '2 Wheeler'] }, 1, 0] }
          },
          fourWheelers: {
            $sum: { $cond: [{ $eq: ['$vehicleType', '4 Wheeler'] }, 1, 0] }
          }
        }
      },
      { $sort: { vehicleCount: -1 } }
    ]);
    
    // Branch-wise detailed breakdown for students
    const branchDetails = await Vehicle.aggregate([
      { $match: { designation: 'Student' } },
      {
        $group: {
          _id: '$branch',
          vehicleCount: { $sum: 1 },
          twoWheelers: {
            $sum: { $cond: [{ $eq: ['$vehicleType', '2 Wheeler'] }, 1, 0] }
          },
          fourWheelers: {
            $sum: { $cond: [{ $eq: ['$vehicleType', '4 Wheeler'] }, 1, 0] }
          }
        }
      },
      { $sort: { vehicleCount: -1 } }
    ]);

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      
      // User Registration Statistics
      users: {
        total: whitelistStats.total,
        registered: whitelistStats.registered,
        pending: whitelistStats.pending,
        students: whitelistStats.students,
        staff: whitelistStats.staff,
        studentBranches: whitelistBranches.map(b => ({ 
          branch: b._id || 'Not Specified', 
          count: b.count 
        })),
        staffDepartments: whitelistDepartments.map(d => ({ 
          department: d._id || 'Not Specified', 
          count: d.count 
        }))
      },
      
      // Vehicle Statistics
      vehicles: {
        total: vehicleStats.total,
        students: vehicleStats.students,
        staff: vehicleStats.staff,
        twoWheelers: vehicleStats.twoWheelers,
        fourWheelers: vehicleStats.fourWheelers,
        recent: recentVehicles,
        studentBranches: vehicleBranches.map(b => ({ 
          branch: b._id || 'Not Specified', 
          count: b.count 
        })),
        staffDepartments: vehicleDepartments.map(d => ({ 
          department: d._id || 'Not Specified', 
          count: d.count 
        })),
        monthlyTrend: monthlyTrend.map(m => ({
          month: `${m._id.year}-${String(m._id.month).padStart(2, '0')}`,
          year: m._id.year,
          monthNumber: m._id.month,
          count: m.count
        }))
      },
      
      // Combined Insights
      insights: {
        registrationRate: parseFloat(registrationRate),
        totalAuthorizedUsers: whitelistStats.registered,
        totalVehiclesRegistered: vehicleStats.total,
        usersWithoutVehicles: Math.max(0, whitelistStats.registered - vehicleStats.total),
        departmentDetails: departmentDetails.map(d => ({
          department: d._id || 'Not Specified',
          totalVehicles: d.vehicleCount,
          twoWheelers: d.twoWheelers,
          fourWheelers: d.fourWheelers
        })),
        branchDetails: branchDetails.map(b => ({
          branch: b._id || 'Not Specified',
          totalVehicles: b.vehicleCount,
          twoWheelers: b.twoWheelers,
          fourWheelers: b.fourWheelers
        }))
      }
    });
  } catch (error) {
    console.error('Detailed stats error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch detailed statistics',
      message: error.message 
    });
  }
});

// Update a vehicle by ID (admin only)
app.patch('/vehicles/:id', requireAdmin, async (req, res) => {
  try {
    await connectDB();
    const { licencePlate, phoneNumber, ...updateData } = req.body;

    // Validate phone number if provided
    if (phoneNumber && !/^[6-9]\d{9}$/.test(phoneNumber)) {
      return res.status(400).json({ 
        error: 'Invalid phone number. Please enter a valid 10-digit Indian mobile number starting with 6, 7, 8, or 9' 
      });
    }
    
    // If updating license plate, check for duplicates
    if (licencePlate) {
      const existing = await Vehicle.findOne({ 
        _id: { $ne: req.params.id },
        licencePlate 
      });
      
      if (existing) {
        return res.status(400).json({ error: 'Another vehicle with this license plate already exists' });
      }
      updateData.licencePlate = licencePlate;
    }

    // If updating phone number, include it in update data
    if (phoneNumber) {
      updateData.phoneNumber = phoneNumber.trim();
    }

    const updatedVehicle = await Vehicle.findByIdAndUpdate(
      req.params.id, 
      updateData,
      {
        new: true, // return the updated document
        runValidators: true, // enforce schema validators
      }
    );

    if (!updatedVehicle) {
      return res.status(404).json({ error: 'Vehicle not found' });
    }

    res.json({ 
      success: true, 
      message: 'Vehicle updated successfully', 
      vehicle: updatedVehicle 
    });
  } catch (error) {
    console.error('Update error:', error);
    res.status(500).json({ error: 'Failed to update vehicle' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    success: false, 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    origin: req.headers.origin || 'none'
  });
});

// Test POST endpoint for debugging
app.post('/test-post', (req, res) => {
  res.json({
    success: true,
    message: 'POST request successful',
    headers: req.headers,
    body: req.body,
    contentType: req.headers['content-type']
  });
});

// =============================================
// WHITELIST MANAGEMENT ENDPOINTS
// =============================================

// Add single email to whitelist (admin only)
app.post('/whitelist/add', requireAdmin, async (req, res) => {
  try {
    await connectDB();
    const { email, userType, branch, department, notes } = req.body;
    
    // Validation
    if (!email || !userType) {
      return res.status(400).json({ 
        success: false,
        error: 'Email and userType are required' 
      });
    }
    
    const normalizedEmail = email.toLowerCase().trim();
    
    // Check if already exists
    const existing = await Whitelist.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(400).json({ 
        success: false,
        error: 'Email already exists in whitelist' 
      });
    }
    
    // Create whitelist entry
    const whitelistEntry = new Whitelist({
      email: normalizedEmail,
      userType,
      branch: userType === 'Student' ? branch : undefined,
      department: userType === 'Staff' ? department : undefined,
      addedBy: req.auth.userId,
      notes
    });
    
    await whitelistEntry.save();
    
    res.json({
      success: true,
      message: 'Email added to whitelist successfully',
      entry: whitelistEntry
    });
  } catch (error) {
    console.error('Add whitelist error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to add email to whitelist: ' + error.message 
    });
  }
});

// Bulk upload emails from Excel (admin only)
app.post('/whitelist/bulk-upload', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    await connectDB();
    
    if (!req.file) {
      return res.status(400).json({ 
        success: false,
        error: 'No file uploaded' 
      });
    }
    
    console.log('Processing Excel file:', req.file.originalname);
    
    // Read Excel file
    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);
    
    console.log(`Found ${data.length} rows in Excel file`);
    
    const results = {
      success: [],
      failed: [],
      skipped: []
    };
    
    // Process each row
    for (const row of data) {
      try {
        // Extract email - handle different column names
        const email = (row.email || row.Email || row.EMAIL || 
                      row['Email ID'] || row['email_id'] || '').toString().trim();
        
        if (!email || !email.includes('@')) {
          results.failed.push({ 
            row, 
            reason: 'Invalid or missing email' 
          });
          continue;
        }
        
        const normalizedEmail = email.toLowerCase();
        
        // Extract userType
        const userType = (row.userType || row.UserType || row.type || row.Type || 
                         row.designation || row.Designation || 'Student').toString().trim();
        
        // Normalize userType
        let normalizedUserType = 'Student';
        if (userType.toLowerCase().includes('staff') || userType.toLowerCase().includes('faculty')) {
          normalizedUserType = 'Staff';
        }
        
        // Extract branch/department
        const branch = row.branch || row.Branch || row.BRANCH || '';
        const department = row.department || row.Department || row.DEPARTMENT || '';
        
        // Check if already exists
        const existing = await Whitelist.findOne({ email: normalizedEmail });
        if (existing) {
          results.skipped.push({ 
            email: normalizedEmail, 
            reason: 'Already exists' 
          });
          continue;
        }
        
        // Create whitelist entry
        const whitelistEntry = new Whitelist({
          email: normalizedEmail,
          userType: normalizedUserType,
          branch: normalizedUserType === 'Student' ? branch : undefined,
          department: normalizedUserType === 'Staff' ? department : undefined,
          addedBy: req.auth.userId,
          notes: `Bulk upload from ${req.file.originalname}`
        });
        
        await whitelistEntry.save();
        results.success.push({ 
          email: normalizedEmail, 
          userType: normalizedUserType 
        });
        
      } catch (rowError) {
        results.failed.push({ 
          row, 
          reason: rowError.message 
        });
      }
    }
    
    console.log('Bulk upload results:', {
      success: results.success.length,
      failed: results.failed.length,
      skipped: results.skipped.length
    });
    
    res.json({
      success: true,
      message: `Bulk upload completed. Added ${results.success.length} emails.`,
      results: {
        added: results.success.length,
        failed: results.failed.length,
        skipped: results.skipped.length,
        details: results
      }
    });
    
  } catch (error) {
    console.error('Bulk upload error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to process bulk upload: ' + error.message 
    });
  }
});

// Get all whitelist entries (admin only)
app.get('/whitelist', requireAdmin, async (req, res) => {
  try {
    await connectDB();
    
    const { status, userType, search } = req.query;
    
    // Build filter
    const filter = {};
    if (status) filter.status = status;
    if (userType) filter.userType = userType;
    if (search) {
      filter.$or = [
        { email: { $regex: search, $options: 'i' } },
        { branch: { $regex: search, $options: 'i' } },
        { department: { $regex: search, $options: 'i' } }
      ];
    }
    
    const entries = await Whitelist.find(filter)
      .sort({ createdAt: -1 })
      .limit(1000);
    
    // Get counts
    const counts = {
      total: await Whitelist.countDocuments({}),
      pending: await Whitelist.countDocuments({ status: 'pending' }),
      registered: await Whitelist.countDocuments({ status: 'registered' }),
      students: await Whitelist.countDocuments({ userType: 'Student' }),
      staff: await Whitelist.countDocuments({ userType: 'Staff' })
    };
    
    res.json({
      success: true,
      entries,
      counts
    });
  } catch (error) {
    console.error('Get whitelist error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch whitelist' 
    });
  }
});

// Delete whitelist entry (admin only)
app.delete('/whitelist/:id', requireAdmin, async (req, res) => {
  try {
    await connectDB();
    
    const entry = await Whitelist.findByIdAndDelete(req.params.id);
    
    if (!entry) {
      return res.status(404).json({ 
        success: false,
        error: 'Whitelist entry not found' 
      });
    }
    
    res.json({
      success: true,
      message: 'Email removed from whitelist'
    });
  } catch (error) {
    console.error('Delete whitelist error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to delete whitelist entry' 
    });
  }
});

// Check if current user's email is whitelisted (public endpoint with auth)
app.get('/whitelist/check-me', requireAuth, async (req, res) => {
  try {
    await connectDB();
    
    const user = await clerkClient.users.getUser(req.auth.userId);
    const userEmail = user.emailAddresses[0]?.emailAddress;
    
    if (!userEmail) {
      return res.status(400).json({ 
        success: false,
        whitelisted: false,
        message: 'No email found' 
      });
    }
    
    const whitelistEntry = await Whitelist.findOne({ 
      email: userEmail.toLowerCase() 
    });
    
    res.json({
      success: true,
      whitelisted: !!whitelistEntry,
      entry: whitelistEntry || null,
      message: whitelistEntry 
        ? 'Your email is authorized for KPT Mangalore' 
        : 'Your email is not in the authorized list. Please contact admin.'
    });
  } catch (error) {
    console.error('Check whitelist error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to check whitelist status' 
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// Start server locally if not running on Vercel
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
}

// Export the app for Vercel serverless functions
module.exports = app;
