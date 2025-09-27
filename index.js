const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { ClerkExpressRequireAuth } = require('@clerk/clerk-sdk-node');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors({
  origin: ['http://localhost:19006', 'exp://192.168.1.*:19000'], // Update with your frontend URLs
  credentials: true
}));
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
  (req, res, next) => {
    if (req.auth.claims?.metadata?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  }
];

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('MongoDB connected'))
.catch((err) => console.error('MongoDB connection error:', err));

// Multer setup for file uploads
const upload = multer({ dest: 'uploads/' });

// Vehicle schema and model
const vehicleSchema = new mongoose.Schema({
  licencePlate: String,
  fullName: String,
  branch: String,
  designation: String,
  photoUrl: String,
});

const Vehicle = mongoose.model('Vehicle', vehicleSchema);

// Upload image endpoint (protected)
app.post('/upload-image', requireAuth, upload.single('image'), async (req, res) => {
  try {
    const result = await cloudinary.uploader.upload(req.file.path);
    res.json({ url: result.secure_url });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// Register vehicle endpoint (protected)
app.post('/register', requireAuth, async (req, res) => {
  try {
    const { licencePlate, fullName, branch, designation, photoUrl } = req.body;
    
    // Check if vehicle with this plate already exists
    const existingVehicle = await Vehicle.findOne({ licencePlate });
    if (existingVehicle) {
      return res.status(400).json({ error: 'Vehicle with this license plate already registered' });
    }

    const vehicle = new Vehicle({ 
      licencePlate, 
      fullName, 
      branch, 
      designation, 
      photoUrl,
      userId: req.auth.userId // Link to Clerk user ID
    });
    
    await vehicle.save();
    res.status(201).json({ message: 'Vehicle registered successfully', vehicle });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Failed to register vehicle' });
  }
});

// Search vehicles endpoint (protected, admin only)
app.get('/vehicles', requireAdmin, async (req, res) => {
  try {
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Delete a vehicle by ID (admin only)
app.delete('/vehicles/:id', requireAdmin, async (req, res) => {
  try {
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

// Update a vehicle by ID (admin only)
app.patch('/vehicles/:id', requireAdmin, async (req, res) => {
  try {
    const { licencePlate, ...updateData } = req.body;
    
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

// Start server
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
  server.close(() => process.exit(1));
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  server.close(() => process.exit(1));
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
    process.exit(0);
  });
});
