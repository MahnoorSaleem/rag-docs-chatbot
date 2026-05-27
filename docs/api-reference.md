# API Reference

## Authentication

All API requests require a valid API key.
Pass the API key in the request header as Authorization Bearer token.
API keys can be generated from your dashboard settings page.
Each API key is tied to a specific account and permission level.
Rotate your API keys regularly for security best practices.

## Rate Limiting

The API enforces rate limits to ensure fair usage.
Default rate limit is 100 requests per minute per API key.
If you exceed the rate limit you will receive a 429 status code.
Wait for the retry-after header value before making new requests.
Contact support to request higher rate limits for production use.

## Endpoints

### GET /users

Returns a list of all users in your account.
Supports pagination using page and limit query parameters.
Default page size is 20 results with a maximum of 100.
Results are sorted by creation date in descending order.
Use the search query parameter to filter users by name or email.

### POST /users

Creates a new user in your account.
Requires name and email fields in the request body.
Returns the created user object with generated ID.
Email address must be unique across all users in your account.
Optional fields include role, department, and phone number.

### PUT /users/:id

Updates an existing user by their ID.
Only include fields you want to update in the request body.
Returns the updated user object on success.
Cannot update email to one already in use by another user.
Partial updates are supported so you do not need to send all fields.

### DELETE /users/:id

Deletes a user by their ID.
This action is permanent and cannot be undone.
Returns 204 status on success.
Associated data may be retained for audit purposes.
Admin permission is required to delete users.

## Error Codes

- 400 Bad Request — missing or invalid parameters
- 401 Unauthorized — invalid or missing API key
- 403 Forbidden — insufficient permissions
- 404 Not Found — resource does not exist
- 429 Too Many Requests — rate limit exceeded
- 500 Internal Server Error — something went wrong on server

## Pagination

All list endpoints support pagination.
Use the page parameter to specify which page to return.
Use the limit parameter to control page size.
Response includes total count and next page URL.
Maximum allowed limit is 100 results per page.

## Request Headers

Content-Type must be set to application/json for POST and PUT requests.
Authorization header must contain Bearer followed by your API key.
Accept header should be set to application/json.
X-Request-ID header can be used to track requests in logs.
