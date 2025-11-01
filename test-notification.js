/**
 * Test script to verify FCM push notifications are working
 * Run this after setting up Firebase Admin SDK
 * 
 * Usage:
 * 1. Make sure FIREBASE_SERVICE_ACCOUNT_KEY is in your .env file
 * 2. Get an FCM token from your Android device (check server logs when user opens app)
 * 3. Run: node test-notification.js YOUR_FCM_TOKEN_HERE
 */

require('dotenv').config();
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT_KEY not found in .env file');
  console.log('\nPlease add your Firebase service account key to .env:');
  console.log('FIREBASE_SERVICE_ACCOUNT_KEY=\'{"type":"service_account",...}\'');
  process.exit(1);
}

try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('✅ Firebase Admin SDK initialized successfully\n');
} catch (error) {
  console.error('❌ Failed to initialize Firebase Admin SDK:', error.message);
  process.exit(1);
}

// Get FCM token from command line argument
const fcmToken = process.argv[2];

if (!fcmToken) {
  console.error('❌ No FCM token provided');
  console.log('\nUsage: node test-notification.js YOUR_FCM_TOKEN_HERE');
  console.log('\nTo get your FCM token:');
  console.log('1. Open the app on your Android device');
  console.log('2. Check the server logs for "FCM token: ..."');
  console.log('3. Copy the token and run this script again');
  process.exit(1);
}

console.log('📱 Sending test notification to:', fcmToken.substring(0, 20) + '...\n');

const message = {
  notification: {
    title: 'Test Notification 🚗',
    body: 'If you received this, FCM push notifications are working correctly!',
  },
  data: {
    screen: 'Admin',
    type: 'test_notification',
    timestamp: new Date().toISOString(),
  },
  token: fcmToken,
  android: {
    priority: 'high',
    notification: {
      sound: 'default',
      channelId: 'default',
    },
  },
};

admin.messaging().send(message)
  .then((response) => {
    console.log('✅ Notification sent successfully!');
    console.log('📝 Message ID:', response);
    console.log('\n✨ Check your Android device for the notification.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Error sending notification:', error.message);
    console.error('\nFull error:', error);
    process.exit(1);
  });
