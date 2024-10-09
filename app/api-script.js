async function makeApiCall(url, method = 'GET', body = null, headers = {}) {
  const baseHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${localStorage.getItem('accessToken')}`,
    ...headers,
  };

  const options = {
    method,
    headers: baseHeaders,
    body: body ? JSON.stringify(body) : null,
  };

  try {
    const response = await fetch(url, options);

    if (response.status === 403) {
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
        throw new Error('Unable to refresh access token');
      }
    }

    return await handleResponse(response);
  } catch (error) {
    console.error('API call failed:', error);
    throw error;
  }
}

async function refreshAccessToken() {
  const refreshToken = localStorage.getItem('refreshToken');
  if (!refreshToken) {
    console.error('No refresh token available');
    return null;
  }

  try {
    const response = await fetch('/api/refresh-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (response.ok) {
      const data = await response.json();
      localStorage.setItem('accessToken', data.accessToken);
      return data.accessToken;
    } else {
      console.error('Failed to refresh token');
      return null;
    }
  } catch (error) {
    console.error('Error refreshing token:', error);
    return null;
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

// Export the function to make it available for use
export { makeApiCall };
