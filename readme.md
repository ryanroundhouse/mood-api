# Mood Tracker API

A RESTful API for a mood tracking application built with Node.js, Express, and MongoDB.

## Features

- User registration with email verification
- User authentication using JWT
- Password reset functionality
- CRUD operations for mood entries
- Data validation and error handling

## Prerequisites

- Node.js
- MongoDB Atlas account
- Gmail account (for sending emails)

## Environment Variables

Set the following environment variables:

- `GMAIL_USERNAME`
- `GMAIL_PASSWORD`
- `JWT_SECRET`

## Installation

1. Clone the repository
2. Run `npm install`
3. Set up environment variables
4. Update the Nodemailer transporter with your email credentials

## Usage

Start the server:

```zsh
node server.js
```

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

- **POST** `/register`

Request:

```json
{
  "email": "user@example.com",
  "name": "John Doe",
  "password": "securepassword123"
}
```

Response:

```json
{
  "message": "User created successfully. Please check your email to verify your account."
}
```

### Verify user email

- **GET** `/verify/:token`

Response:

```json
{
  "message": "Email verified successfully. You can now log in."
}
```

### User login

- **POST** `/login`

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
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### Create/update a mood entry

- **POST** `/mood`

Request:

```json
{
  "datetime": "2023-04-15T14:30:00Z",
  "rating": 4,
  "comment": "Feeling pretty good today!"
}
```

Response:

```json
{
  "id": "60a12345b9f1a82468d4f678",
  "user": "60a12345b9f1a82468d4f123",
  "datetime": "2023-04-15T14:30:00.000Z",
  "rating": 4,
  "comment": "Feeling pretty good today!"
}
```

### Get all mood entries

- **GET** `/moods`

Response:

```json
[
  {
    "id": "60a12345b9f1a82468d4f678",
    "user": "60a12345b9f1a82468d4f123",
    "datetime": "2023-04-15T14:30:00.000Z",
    "rating": 4,
    "comment": "Feeling pretty good today!"
  },
  {
    "id": "60a12345b9f1a82468d4f679",
    "user": "60a12345b9f1a82468d4f123",
    "datetime": "2023-04-14T10:15:00.000Z",
    "rating": 3,
    "comment": "Average day"
  }
]
```

### Initiate password reset

- **POST** `/forgot-password`

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

### Reset password

- **POST** `/reset-password/:token`

Replace `:token` with the reset token received in the email.

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

### Get user settings

- **GET** `/user/settings`

Response:

```json
{
"name": "John Doe",
"dailyNotifications": true,
"weeklySummary": true
}
```

### Update user settings

- **PUT** `/user/settings`

Request:

```json
{
"name": "John Smith",
"dailyNotifications": false,
"weeklySummary": true
}
```

Response:

```json
{
"message": "Settings updated successfully"
}
```

## Security

- Passwords are hashed using bcrypt
- JWT is used for authentication
- Input validation is performed using express-validator

## Error Handling

Custom error handling middleware is implemented to catch and respond to errors.

## License

[MIT License](https://opensource.org/licenses/MIT)
