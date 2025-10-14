const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { ClerkExpressRequireAuth, clerkClient } = require('@clerk/clerk-sdk-node');
const { Expo } = require('expo-server-sdk');
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

// CORS middleware
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.some(allowedOrigin => 
    typeof allowedOrigin === 'string' 
      ? origin === allowedOrigin 
      : allowedOrigin.test(origin)
  )) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
    
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
  vehicleName: { type: String, required: true }, // Vehicle name/model
  vehiclePhotoUrl: { type: String, required: true }, // Vehicle photo
  ownerPhotoUrl: { type: String, required: true }, // Owner photo
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
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Vehicle = mongoose.model('Vehicle', vehicleSchema);

// User schema for storing push tokens and other user data
const userSchema = new mongoose.Schema({
  clerkId: { type: String, required: true, unique: true },
  pushToken: { type: String },
  role: { type: String, default: 'user' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Notification helper function
const sendPushNotification = async (pushToken, title, body, data = {}) => {
  if (!Expo.isExpoPushToken(pushToken)) {
    console.error(`Push token ${pushToken} is not a valid Expo push token`);
    return;
  }

  const expo = new Expo();
  const message = {
    to: pushToken,
    title,
    body,
    data,
    sound: 'default',
    priority: 'default',
  };

  try {
    const ticket = await expo.sendPushNotificationsAsync([message]);
    console.log('Notification sent:', ticket);
    return ticket;
  } catch (error) {
    console.error('Error sending notification:', error);
  }
};

// Register push token endpoint (protected)
app.post('/register-push-token', requireAuth, async (req, res) => {
  try {
    await connectDB();
    const { pushToken } = req.body;

    if (!pushToken) {
      return res.status(400).json({ error: 'Push token is required' });
    }

    // Upsert user with push token
    await User.findOneAndUpdate(
      { clerkId: req.auth.userId },
      {
        pushToken,
        updatedAt: new Date()
      },
      { upsert: true, new: true }
    );

    res.json({ success: true, message: 'Push token registered successfully' });
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

// Register vehicle endpoint (protected)
app.post('/register', requireAuth, async (req, res) => {
  console.log('\n=== New Registration Request ===');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Auth:', JSON.stringify(req.auth || {}, null, 2));
  
  try {
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    
    // Validate required fields
    const requiredFields = [
      'licencePlate', 'fullName', 'branch', 'designation', 
      'vehicleName', 'vehiclePhotoUrl', 'ownerPhotoUrl', 'phoneNumber'
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
      vehiclePhotoUrl,
      ownerPhotoUrl,
      phoneNumber,
      userId = req.auth?.userId // Fallback to auth userId if not in body
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
        vehicleName: vehicleName.trim(),
        vehiclePhotoUrl,
        ownerPhotoUrl,
        phoneNumber: phoneNumber.trim(),
        userId
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
          if (admin.pushToken) {
            console.log(`Sending notification to admin: ${admin._id}`);
            return sendPushNotification(
              admin.pushToken,
              'New Vehicle Registered',
              `Vehicle ${normalizedPlate} registered by ${fullName}`,
              { 
                screen: 'Admin',
                vehicleId: savedVehicle._id
              }
            ).catch(e => {
              console.error(`Failed to send notification to admin ${admin._id}:`, e);
              return null;
            });
          }
          return Promise.resolve();
        });

        await Promise.all(notificationPromises);
        console.log('All notifications sent');
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

// Get user's own vehicles endpoint (protected)
app.get('/my-vehicles', requireAuth, async (req, res) => {
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

// Update user's own vehicle endpoint (protected)
app.patch('/my-vehicles/:id', requireAuth, async (req, res) => {
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

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// Export the app for Vercel serverless functions
module.exports = app;
