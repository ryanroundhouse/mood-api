const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const axios = require('axios');
const logger = require('../utils/logger');
const transporter = require('../utils/mailer');

const MY_EMAIL = process.env.EMAIL_ADDRESS;
const NOREPLY_EMAIL = process.env.NOREPLY_EMAIL;

// Contact form submission endpoint
router.post(
  '/',
  [
    body('name').trim().isLength({ min: 1, max: 100 }).escape(),
    body('email').isEmail().normalizeEmail(),
    body('subject').trim().isLength({ min: 1, max: 200 }).escape(),
    body('message').trim().isLength({ min: 1, max: 1000 }).escape(),
    body('recaptchaToken').notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email, subject, message, recaptchaToken } = req.body;

    // Verify reCAPTCHA token
    try {
      const recaptchaResponse = await axios.post(
        `https://www.google.com/recaptcha/api/siteverify?secret=${process.env.RECAPTCHA_SECRET_KEY}&response=${recaptchaToken}`
      );

      if (
        !recaptchaResponse.data.success ||
        recaptchaResponse.data.score < 0.5
      ) {
        logger.warn(`reCAPTCHA verification failed for ${email}`);
        return res.status(400).json({ error: 'reCAPTCHA verification failed' });
      }
    } catch (error) {
      logger.error('Error verifying reCAPTCHA:', error);
      return res.status(500).json({ error: 'Error verifying reCAPTCHA' });
    }

    // Send email
    transporter.sendMail(
      {
        from: NOREPLY_EMAIL,
        to: MY_EMAIL,
        subject: `New Contact Form Submission: ${subject}`,
        html: `
          <h3>New contact form submission</h3>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Subject:</strong> ${subject}</p>
          <p><strong>Message:</strong></p>
          <p>${message}</p>
        `,
      },
      (error, info) => {
        if (error) {
          logger.error('Error sending contact form email:', error);
          return res.status(500).json({ error: 'Error sending message' });
        }

        logger.info(`Contact form submission from ${email}`);
        res.status(200).json({ message: 'Message sent successfully' });
      }
    );
  }
);

module.exports = router;
