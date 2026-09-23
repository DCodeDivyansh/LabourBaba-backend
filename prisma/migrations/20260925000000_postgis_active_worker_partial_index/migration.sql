-- Create partial GiST index on active, verified, online workers for fast candidate spatial search
CREATE INDEX IF NOT EXISTS idx_worker_online_verified_location
ON worker USING GIST (location_geo)
WHERE is_online = true AND deleted_at IS NULL AND verification_status = 'verified';

-- Create composite index on booking(worker_id, status) to optimize candidate busy-worker exclusion
CREATE INDEX IF NOT EXISTS idx_booking_worker_status
ON booking(worker_id, status);
