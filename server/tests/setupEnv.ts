// Runs before any app module is imported.
//
// Tests must be hermetic: never read the developer's real server/.env (it holds live keys –
// e.g. SMTP would send real emails, Gemini would spend quota). `dotenv/config` honours
// DOTENV_CONFIG_PATH, so point it at a file that doesn't exist.
process.env.DOTENV_CONFIG_PATH = 'tests/.env.does-not-exist';

// Clear anything inherited from the shell that would reach a real service.
for (const key of [
  'SMTP_URL', 'GOOGLE_API_KEY', 'REDIS_URL', 'RECORDING_S3_BUCKET', 'RECORDING_S3_ACCESS_KEY', 'RECORDING_S3_SECRET',
  'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'MEMORY_VECTOR_INDEX', 'REQUIRE_EMAIL_VERIFICATION',
]) {
  delete process.env[key];
}

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://placeholder'; // real URI comes from mongodb-memory-server
process.env.JWT_SECRET = 'test-secret-at-least-16-chars';
process.env.LIVEKIT_URL = 'wss://test.livekit.cloud';
process.env.LIVEKIT_API_KEY = 'devkey';
process.env.LIVEKIT_API_SECRET = 'devsecret-devsecret-devsecret-devsecret';
process.env.AGENT_NAME = 'aumeet';
process.env.WEB_URL = 'http://localhost:4200';
process.env.PUBLIC_API_URL = 'http://localhost:4200';
process.env.CORS_ORIGINS = 'http://localhost:4200';
process.env.TRUST_PROXY = '1';
process.env.DATA_RETENTION_DAYS = '0';
process.env.GOOGLE_CLIENT_ID = 'g-id';
process.env.GOOGLE_CLIENT_SECRET = 'g-secret';
