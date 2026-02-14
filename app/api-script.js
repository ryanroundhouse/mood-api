let accessToken = null;

function clearAuthState() {
  accessToken = null;
}

async function refreshAccessToken() {
  try {
    const response = await fetch('/api/web-auth/refresh-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (response.ok) {
      const data = await response.json();
      accessToken = data.accessToken;
      return accessToken;
    }

    // Not logged in (or refresh expired)
    return null;
  } catch (error) {
    console.error('Error refreshing token:', error);
    return null;
  }
}

async function ensureAccessToken() {
  if (accessToken) return accessToken;
  return await refreshAccessToken();
}

async function authenticatedApiCall(url, method = 'GET', body = null, headers = {}) {
  const token = await ensureAccessToken();
  if (!token) {
    const err = new Error('Not authenticated');
    err.code = 'NOT_AUTHENTICATED';
    throw err;
  }

  const baseHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    ...headers,
  };

  const options = {
    method,
    headers: baseHeaders,
    body: body ? JSON.stringify(body) : null,
  };

  try {
    const response = await fetch(url, options);

    if (response.status === 401) {
      // Token might be expired, attempt to refresh
      const newAccessToken = await refreshAccessToken();
      if (newAccessToken) {
        // Retry the original request with the new token
        baseHeaders.Authorization = `Bearer ${newAccessToken}`;
        const retryResponse = await fetch(url, {
          ...options,
          headers: baseHeaders,
        });
        return await handleResponse(retryResponse);
      } else {
        clearAuthState();
        throw new Error('Unable to refresh access token');
      }
    }

    return await handleResponse(response);
  } catch (error) {
    console.error('API call failed:', error);
    throw error;
  }
}

async function handleResponse(response) {
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      errorData.message || `HTTP error! status: ${response.status}`
    );
  }
  return await response.json();
}

async function unauthenticatedApiCall(
  url,
  method = 'GET',
  body = null,
  headers = {}
) {
  const baseHeaders = {
    'Content-Type': 'application/json',
    ...headers,
  };

  const options = {
    method,
    headers: baseHeaders,
    body: body ? JSON.stringify(body) : null,
  };

  try {
    const response = await fetch(url, options);
    return await handleResponse(response);
  } catch (error) {
    console.error('Unauthenticated API call failed:', error);
    throw error;
  }
}

export {
  authenticatedApiCall,
  unauthenticatedApiCall,
  ensureAccessToken,
  clearAuthState,
};
