const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

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
}).then(() => console.log('MongoDB connected'))
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

// Upload image endpoint
app.post('/upload-image', upload.single('image'), async (req, res) => {
  try {
    const result = await cloudinary.uploader.upload(req.file.path);
    res.json({ url: result.secure_url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Register vehicle endpoint
app.post('/register', async (req, res) => {
  try {
    const { licencePlate, fullName, branch, designation, photoUrl } = req.body;
    const vehicle = new Vehicle({ licencePlate, fullName, branch, designation, photoUrl });
    await vehicle.save();
    res.status(201).json({ message: 'Vehicle registered', vehicle });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search vehicles by licence plate
app.get('/vehicles', async (req, res) => {
  const plate = req.query.licencePlate;
  if (!plate) {
    return res.status(400).json({ error: 'licencePlate query parameter required' });
  }
  try {
    const vehicles = await Vehicle.find({ licencePlate: { $regex: plate, $options: 'i' } });
    res.json(vehicles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Simple admin login endpoint
app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;

  // Replace with real credential check or use database in production
  const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'password123';

  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    // For simplicity, returning a dummy token
    return res.json({ token: 'dummy-admin-token' });
  }
  return res.status(401).json({ error: 'Invalid credentials' });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
