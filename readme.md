# Moodful API

A RESTful API for a mood tracking application built with Node.js, Express, and SQLite.

## Features

- User registration with email verification
- User authentication using JWT
- Password reset functionality
- CRUD operations for mood entries
- Custom user activities for Pro and Enterprise users
- Stripe integration for subscription management
- Data validation and error handling
- Rate limiting for sensitive routes
- Logging with Winston
- CORS support in development mode

## Prerequisites

- Node.js
- SQLite
- Stripe account
- Mailgun account
- reCAPTCHA v3 setup

## Environment Variables

Set the following environment variables:

- `JWT_SECRET`: Secret key for JWT
- `MAILGUN_API_KEY`: Mailgun API key
- `EMAIL_DOMAIN`: Mailgun domain
- `NOREPLY_EMAIL`: No-reply email address
- `EMAIL_ADDRESS`: Your email address for receiving contact form submissions
- `STRIPE_SECRET_KEY`: Stripe secret key
- `STRIPE_PRICE_ID`: Stripe price ID for subscription
- `STRIPE_WEBHOOK_SECRET`: Stripe webhook secret
- `RECAPTCHA_SECRET_KEY`: reCAPTCHA v3 secret key
- `MOOD_SITE_URL`: Base URL of your site (default: http://localhost:3000)

## Installation

1. Clone the repository
2. Run `npm install`
3. Set up environment variables
4. Run `node server.js`

## Usage

The API will be available at `http://localhost:3000`

## API Endpoints

When making requests to these endpoints, make sure to:

1. Use the correct HTTP method (GET, POST, etc.)
2. Set the `Content-Type` header to `application/json` for POST requests
3. Include the JWT token in the `Authorization` header for protected routes:
   ```
   Authorization: Bearer your_jwt_token
   ```

### Register a new user

- **POST** `/api/register`

Request:

```json
{
  "email": "user@example.com",
  "name": "John Doe",
  "password": "securepassword123",
  "paymentMethodId": "pm_..." // Optional, for immediate Pro subscription
}
```

Response:

```json
{
  "message": "User created successfully. Please check your email to verify your account."
}
```

Possible errors:

- 400: Email already exists
- 500: Error registering user

### Verify user email

- **GET** `/api/verify/:token`

Response: Redirects to login page with `verified=true` parameter

Possible errors:

- 400: Invalid verification token
- 500: Error verifying email

### User login

- **POST** `/api/login`

Request:

```json
{
  "email": "user@example.com",
  "password": "securepassword123"
}
```

Response:

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "1234567890abcdef1234567890abcdef12345678"
}
```

Possible errors:

- 400: Invalid email or password
- 400: Please verify your email before logging in
- 500: Error logging in

### Refresh access token

- **POST** `/api/refresh-token`

Request:

```json
{
  "refreshToken": "1234567890abcdef1234567890abcdef12345678"
}
```

Response:

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

Possible errors:

- 400: Refresh token is required
- 401: Invalid or expired refresh token
- 401: User not found
- 500: Internal server error

### User logout

- **POST** `/api/logout`

Request:

```json
{
  "refreshToken": "1234567890abcdef1234567890abcdef12345678"
}
```

Response:

```json
{
  "message": "Logged out successfully"
}
```

Possible errors:

- 400: Refresh token is required
- 500: Internal server error

### Create/update a mood entry

- **POST** `/api/mood`

Request:

```json
{
  "datetime": "2023-04-15T14:30:00Z", // Optional, defaults to current time
  "rating": 4,
  "comment": "Feeling pretty good today!",
  "activities": ["exercise", "reading"] // Optional
}
```

Response:

```json
{
  "id": 1,
  "userId": 1,
  "datetime": "2023-04-15T14:30:00.000Z",
  "rating": 4,
  "comment": "Feeling pretty good today!",
  "activities": ["exercise", "reading"]
}
```

Possible errors:

- 400: Validation errors
- 500: Internal server error

### Get all mood entries

- **GET** `/api/moods`

Response:

```json
[
  {
    "id": 1,
    "userId": 1,
    "datetime": "2023-04-15T14:30:00.000Z",
    "rating": 4,
    "comment": "Feeling pretty good today!",
    "activities": ["exercise", "reading"]
  }
  // ... more mood entries
]
```

Possible errors:

- 500: Internal server error

### Initiate password reset

- **POST** `/api/forgot-password`

Request:

```json
{
  "email": "user@example.com"
}
```

Response:

```json
{
  "message": "Password reset email sent"
}
```

Possible errors:

- 404: User not found
- 500: Internal server error

### Reset password

- **POST** `/api/reset-password/:token`

Request:

```json
{
  "password": "newSecurePassword456"
}
```

Response:

```json
{
  "message": "Password reset successful"
}
```

Possible errors:

- 400: Invalid or expired reset token
- 500: Internal server error

### Get user settings

- **GET** `/api/user/settings`

Response:

```json
{
  "name": "John Doe",
  "email": "user@example.com",
  "accountLevel": "basic",
  "emailDailyNotifications": true,
  "emailWeeklySummary": true,
  "appDailyNotifications": true,
  "appWeeklySummary": true,
  "appDailyNotificationTime": "20:00"
}
```

Possible errors:

- 404: User not found
- 500: Internal server error

### Update user settings

- **PUT** `/api/user/settings`

Request body:

```json
{
  "name": "John Smith", // Optional
  "emailDailyNotifications": false, // Optional
  "emailWeeklySummary": true, // Optional
  "appDailyNotifications": false, // Optional
  "appWeeklySummary": true, // Optional
  "appDailyNotificationTime": "20:00" // Optional, 24-hour format (HH:mm)
}
```

Notes:

- All fields are optional. Only include the fields you want to update.
- `name` must be a non-empty string if provided.
- All notification settings (`emailDailyNotifications`, `emailWeeklySummary`, `appDailyNotifications`, `appWeeklySummary`) must be boolean values if provided.
- `appDailyNotificationTime` must be in 24-hour format (HH:mm) if provided. Defaults to "20:00" if not set.

Response:

```json
{
  "message": "Settings updated successfully"
}
```

Possible errors:

- 400: Validation errors (e.g., invalid data types, empty name, or invalid time format)
- 500: Internal server error

### Get user activities (Pro/Enterprise only)

- **GET** `/api/user/activities`

Response:

```json
{
  "activities": ["exercise", "reading", "meditation"]
}
```

Possible errors:

- 403: Access denied (not Pro/Enterprise)
- 500: Internal server error

### Update user activities (Pro/Enterprise only)

- **POST** `/api/user/activities`

Request:

```json
{
  "activities": ["exercise", "reading", "meditation", "cooking"]
}
```

Response:

```json
{
  "message": "Activities updated successfully",
  "activities": ["exercise", "reading", "meditation", "cooking"],
  "maxActivities": 5
}
```

Notes:

- Basic users can add up to 5 custom activities.
- Pro and Enterprise users can add up to 20 custom activities.

Possible errors:

- 400: Validation errors
- 400: Exceeded maximum number of activities for account level
- 500: Internal server error

### Submit contact form

- **POST** `/api/contact`

Request:

```json
{
  "name": "John Doe",
  "email": "user@example.com",
  "subject": "Question about Moodful",
  "message": "I have a question about...",
  "recaptchaToken": "recaptcha_token_here"
}
```

Response:

```json
{
  "message": "Message sent successfully"
}
```

Possible errors:

- 400: Validation errors
- 400: reCAPTCHA verification failed
- 500: Error sending message

### Upgrade account to Pro

- **POST** `/api/upgrade`

Request:

```json
{
  "paymentMethodId": "pm_..."
}
```

Response:

```json
{
  "message": "Your account has been upgraded to Pro!"
}
```

Possible errors:

- 404: User not found
- 500: An error occurred. Please try again.

### Downgrade account to Basic

- **POST** `/api/downgrade`

Response:

```json
{
  "message": "Your account has been downgraded to Basic."
}
```

Possible errors:

- 404: Subscription not found
- 500: An error occurred. Please try again.

### Get user's weekly summary

- **GET** `/api/user/summary`

Response:

```json
{
  "basicInsights": [
    {
      "name": "Physical Activity Benefits",
      "description": "Engaging in physical activities increased your mood to an average of 3.00."
    },
    {
      "name": "Family Time Impact",
      "description": "Spending time with family increased your mood to an average of 4.00."
    }
    // More basic insight objects...
  ],
  "aiInsights": [
    {
      "name": "Mood Insights",
      "description": "Your mood ratings align well with activities and comments. Work stress may be influencing your constant mood rating of 3."
    },
    {
      "name": "Trends and Correlations",
      "description": "Consistent mood rating of 3, regardless of events. Work environment significantly influences mood."
    }
    // More AI-generated insight objects...
  ]
}
```

Possible errors:

- 404: Summary not found
- 500: Internal server error

### Get all user's summaries

- **GET** `/api/user/summaries`

Response:

```json
[
  {
    "date": "2024-03-21",
    "basicInsights": [
      {
        "name": "Physical Activity Benefits",
        "description": "Engaging in physical activities increased your mood to an average of 3.00."
      }
      // More basic insight objects...
    ],
    "aiInsights": [
      {
        "name": "Mood Insights",
        "description": "Your mood ratings align well with activities and comments."
      }
      // More AI-generated insight objects...
    ]
  },
  {
    "date": "2024-03-14",
    "basicInsights": [...],
    "aiInsights": [...]
  }
  // More weekly summaries...
]
```

Notes:

- Returns all available summaries for the user, ordered by date (newest first)
- Each summary includes both basic and AI-generated insights
- Insights are automatically decrypted before being sent

Possible errors:

- 404: No summaries found
- 500: Internal server error

## Security

- Passwords are hashed using bcrypt
- JWT is used for authentication
- Input validation is performed using express-validator
- Rate limiting is applied to sensitive routes
- CORS is enabled in development mode

## Error Handling

Custom error handling middleware is implemented to catch and respond to errors. Errors are logged using Winston.

## Development Mode

When running in development mode (`NODE_ENV=development`), CORS is enabled for all origins to facilitate easier debugging and development.

## License

[MIT License](https://opensource.org/licenses/MIT)
