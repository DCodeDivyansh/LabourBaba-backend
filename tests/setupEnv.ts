// Baseline test environment configuration
// Provides isolated test secrets when running in CI or environments without local .env
if (!process.env.JWT_ACCESS_SECRET) {
  process.env.JWT_ACCESS_SECRET = "test_access_secret_0123456789abcdef0123456789abcdef";
}
if (!process.env.JWT_REFRESH_SECRET) {
  process.env.JWT_REFRESH_SECRET = "test_refresh_secret_fedcba9876543210fedcba9876543210";
}
