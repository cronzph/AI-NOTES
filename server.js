import dotenv from 'dotenv';
import express from 'express';

dotenv.config();
const app = express();

// Serve your static files (index.html, etc.)
app.use(express.static('.')); // naka-serve ang index.html sa same folder

// This is the endpoint na hina-hit ng index.html mo
app.get('/api/config', (req, res) => {
  res.json({
    firebase: {
      apiKey: process.env.FIREBASE_API_KEY,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN,
      databaseURL: process.env.FIREBASE_DATABASE_URL,
      projectId: process.env.FIREBASE_PROJECT_ID,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.FIREBASE_APP_ID,
    }
  });
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));