const express = require('express');
const mongoose = require('mongoose');
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const app = express();
const port = 3000;

// MongoDB connection
const MONGODB_USERNAME = process.env.MONGODB_USERNAME;
const MONGODB_PASSWORD = process.env.MONGODB_PASSWORD;
const MONGODB_CLUSTER_URL = process.env.MONGODB_CLUSTER_URL;
// Gmail credentials
const GMAIL_USERNAME = process.env.EMAIL_USERNAME;
const GMAIL_PASSWORD = process.env.EMAIL_PASSWORD;
// JWT
const JWT_SECRET = process.env.JWT_SECRET;

mongoose
  .connect(
    `mongodb+srv://${MONGODB_USERNAME}:${MONGODB_PASSWORD}@${MONGODB_CLUSTER_URL}/moodtracker?retryWrites=true&w=majority`,
    {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    }
  )
  .then(() => console.log('Connected to MongoDB Atlas'))
  .catch((err) => console.error('MongoDB Atlas connection error:', err));

// Updated User model
const User = mongoose.model(
  'User',
  new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    name: { type: String },
    password: { type: String, required: true },
    isVerified: { type: Boolean, default: false },
    verificationToken: { type: String },
    resetPasswordToken: { type: String },
    resetPasswordExpires: { type: Date },
  })
);

// Updated Mood model
const Mood = mongoose.model(
  'Mood',
  new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    datetime: { type: Date, required: true },
    rating: { type: Number, required: true, min: 0, max: 5 },
    comment: { type: String, maxlength: 500 }, // New optional field
  })
);

app.use(express.json());

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token == null) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// Nodemailer transporter setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: GMAIL_USERNAME,
    pass: GMAIL_PASSWORD,
  },
});

// Updated User registration
app.post(
  '/register',
  [
    body('email').isEmail(),
    body('name').optional().trim().escape(),
    body('password').isLength({ min: 6 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { email, name, password } = req.body;
      const hashedPassword = await bcrypt.hash(password, 10);
      const verificationToken = crypto.randomBytes(20).toString('hex');

      const user = new User({
        email,
        name,
        password: hashedPassword,
        verificationToken,
      });
      await user.save();

      // Send verification email
      const verificationLink = `http://localhost:${port}/verify/${verificationToken}`;
      await transporter.sendMail({
        to: email,
        subject: 'Verify your email',
        html: `Please click this link to verify your email: <a href="${verificationLink}">${verificationLink}</a>`,
      });

      res.status(201).json({
        message:
          'User created successfully. Please check your email to verify your account.',
      });
    } catch (error) {
      console.error('Error during registration:', error);
      if (error.code === 11000) {
        return res.status(400).json({ error: 'Email already exists' });
      }
      res.status(500).json({ error: 'Error registering user' });
    }
  }
);

// New route for email verification
app.get('/verify/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const user = await User.findOne({ verificationToken: token });

    if (!user) {
      return res.status(400).json({ error: 'Invalid verification token' });
    }

    user.isVerified = true;
    user.verificationToken = undefined;
    await user.save();

    res.json({ message: 'Email verified successfully. You can now log in.' });
  } catch (error) {
    console.error('Error verifying email:', error);
    res.status(500).json({ error: 'Error verifying email' });
  }
});

// Updated User login
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }
    if (!user.isVerified) {
      return res
        .status(400)
        .json({ error: 'Please verify your email before logging in' });
    }
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }
    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token });
  } catch (error) {
    res.status(500).json({ error: 'Error logging in' });
  }
});

// Enhanced mood creation route (now includes optional comment)
app.post(
  '/mood',
  authenticateToken,
  [
    body('datetime').isISO8601().toDate(),
    body('rating').isInt({ min: 0, max: 5 }),
    body('comment').optional().isString().trim().isLength({ max: 500 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { datetime, rating, comment } = req.body;
      const userId = req.user.id;

      // Get the start and end of the day for the given datetime
      const startOfDay = new Date(datetime);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(datetime);
      endOfDay.setHours(23, 59, 59, 999);

      // Find and update existing mood for the day, or create a new one
      const updatedMood = await Mood.findOneAndUpdate(
        {
          user: userId,
          datetime: { $gte: startOfDay, $lte: endOfDay },
        },
        {
          user: userId,
          datetime,
          rating,
          comment,
        },
        { new: true, upsert: true }
      );

      res.status(201).json(updatedMood);
    } catch (error) {
      console.error('Error creating/updating mood:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Get all mood entries for the authenticated user
app.get('/moods', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const moods = await Mood.find({ user: userId }).sort({ datetime: -1 });
    res.json(moods);
  } catch (error) {
    console.error('Error fetching moods:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Serve static content from the /app folder
app.use(express.static('app'));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/app/index.html');
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

app.listen(port, () => {
  console.log(`API listening at http://localhost:${port}`);
});

// New route for forgot password
app.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const resetToken = crypto.randomBytes(20).toString('hex');
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = Date.now() + 3600000; // 1 hour
    await user.save();

    const resetLink = `http://localhost:${port}/reset-password/${resetToken}`;
    await transporter.sendMail({
      to: email,
      subject: 'Password Reset',
      html: `Please click this link to reset your password: <a href="${resetLink}">${resetLink}</a>`,
    });

    res.json({ message: 'Password reset email sent' });
  } catch (error) {
    console.error('Error in forgot password:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// New route for password reset
app.post('/reset-password/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    user.password = hashedPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    res.json({ message: 'Password reset successful' });
  } catch (error) {
    console.error('Error in password reset:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
