const express = require('express');
const mongoose = require('mongoose');
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const app = express();
const port = 3000;

// MongoDB connection
mongoose
  .connect('mongodb://localhost:27017/moodtracker', {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log('Connected to MongoDB'))
  .catch((err) => console.error('MongoDB connection error:', err));

// Updated User model
const User = mongoose.model(
  'User',
  new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    name: { type: String },
    password: { type: String, required: true },
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

const JWT_SECRET = 'your_jwt_secret'; // In production, use an environment variable

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
      const user = new User({
        email,
        name,
        password: hashedPassword,
      });
      await user.save();
      res.status(201).json({ message: 'User created successfully' });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(400).json({ error: 'Email already exists' });
      }
      res.status(500).json({ error: 'Error registering user' });
    }
  }
);

// Updated User login
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: 'Invalid email or password' });
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

      const mood = new Mood({
        user: userId,
        datetime,
        rating,
        comment, // This will be undefined if not provided
      });
      await mood.save();

      res.status(201).json(mood);
    } catch (error) {
      console.error('Error creating mood:', error);
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

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

app.listen(port, () => {
  console.log(`API listening at http://localhost:${port}`);
});
