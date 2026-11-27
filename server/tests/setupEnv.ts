// Runs before any app module is imported, so env validation passes.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://placeholder'; // real URI comes from mongodb-memory-server
process.env.JWT_SECRET = 'test-secret-at-least-16-chars';
process.env.LIVEKIT_URL = 'wss://test.livekit.cloud';
process.env.LIVEKIT_API_KEY = 'devkey';
process.env.LIVEKIT_API_SECRET = 'devsecret-devsecret-devsecret-devsecret';
process.env.GOOGLE_CLIENT_ID = 'g-id';
process.env.GOOGLE_CLIENT_SECRET = 'g-secret';
delete process.env.GITHUB_CLIENT_ID;
delete process.env.GITHUB_CLIENT_SECRET;
