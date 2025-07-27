# Manual Testing Guide for Apple Store Endpoints

This guide shows how to manually test the Apple Store endpoints using curl commands.

## Prerequisites

1. **Start your server**:
   ```bash
   cd mood-api
   npm start
   ```

2. **Environment variables** should be set in your `.env` file:
   ```bash
   APPLE_SHARED_SECRET=your_app_specific_shared_secret
   JWT_SECRET=your_jwt_secret
   ```

## Step 1: Create a Test User (if needed)

```bash
curl -X POST http://localhost:3000/api/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "test123",
    "name": "Test User"
  }'
```

**Expected Response**: 
```json
{
  "message": "User created successfully. Please check your email to verify your account."
}
```

## Step 2: Authenticate and Get Token

```bash
curl -X POST http://localhost:3000/api/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "test123"
  }'
```

**Expected Response**:
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "uuid-string"
}
```

**Save the accessToken** for the next steps!

## Step 3: Test Subscription Status Endpoint

```bash
# Replace YOUR_ACCESS_TOKEN with the token from step 2
curl -X GET http://localhost:3000/api/apple-store/subscription-status \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json"
```

**Expected Response** (for user with no subscription):
```json
{
  "status": "no_subscription"
}
```

## Step 4: Test Verify Purchase Endpoint (Input Validation)

```bash
# Test with sample data (should fail gracefully)
curl -X POST http://localhost:3000/api/apple-store/verify-purchase \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "receiptData": "fake-receipt-data",
    "productId": "com.moodful.app.pro.monthly"
  }'
```

**Expected Response** (should return error about invalid receipt):
```json
{
  "error": "Error validating receipt with Apple"
}
```

## Step 5: Test Input Validation

### Test missing receiptData:
```bash
curl -X POST http://localhost:3000/api/apple-store/verify-purchase \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "productId": "com.moodful.app.pro.monthly"
  }'
```

**Expected Response**:
```json
{
  "errors": [
    {
      "msg": "Receipt data is required",
      "param": "receiptData"
    }
  ]
}
```

### Test missing productId:
```bash
curl -X POST http://localhost:3000/api/apple-store/verify-purchase \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "receiptData": "fake-receipt-data"
  }'
```

**Expected Response**:
```json
{
  "errors": [
    {
      "msg": "Product ID is required",
      "param": "productId"
    }
  ]
}
```

### Test without authentication:
```bash
curl -X POST http://localhost:3000/api/apple-store/verify-purchase \
  -H "Content-Type: application/json" \
  -d '{
    "receiptData": "fake-receipt-data",
    "productId": "com.moodful.app.pro.monthly"
  }'
```

**Expected Response**:
```json
{
  "error": "No token provided"
}
```

## What Each Test Validates

- ✅ **Authentication working**: Login returns valid JWT token
- ✅ **Authorization middleware**: Endpoints require valid auth token
- ✅ **Input validation**: Required fields are properly validated
- ✅ **Apple receipt validation**: Endpoint attempts to validate with Apple servers
- ✅ **Error handling**: Graceful error responses for invalid data
- ✅ **Environment config**: APPLE_SHARED_SECRET is loaded and used

## Interpreting Results

### ✅ Good Signs:
- Authentication works (login returns token)
- Subscription status returns `{"status": "no_subscription"}`
- Verify purchase fails with Apple validation error (expected with fake data)
- Input validation errors for missing fields
- 401 errors when no auth token provided

### ❌ Bad Signs:
- 500 errors (server configuration issues)
- "Apple shared secret not configured" (missing environment variable)
- Connection refused (server not running)
- Authentication always fails (database/user issues)

## Testing with Real Apple Receipt

To test with a real Apple receipt (from App Store sandbox):

1. Get a real receipt from your app in sandbox mode
2. Use the receipt data in the verify-purchase endpoint
3. Should return successful validation if receipt is valid

```bash
curl -X POST http://localhost:3000/api/apple-store/verify-purchase \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "receiptData": "REAL_BASE64_RECEIPT_DATA_HERE",
    "productId": "com.moodful.app.pro.monthly"
  }'
```

## Next Steps

If all manual tests pass:
1. ✅ Backend is properly configured
2. ✅ Authentication is working
3. ✅ Apple Store endpoints are functional
4. The issue is likely in the app's subscription configuration or App Store Connect setup 