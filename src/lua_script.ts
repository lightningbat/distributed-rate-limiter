export default `
local key = KEYS[1]

local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

-- Fetch existing bucket state
local data = redis.call("HMGET", key, "tokens", "last")
local tokens = tonumber(data[1])
local last = tonumber(data[2])

-- Initialize bucket if it doesn't exist
if tokens == nil or last == nil then
    tokens = capacity
    last = now
else
    -- Refill tokens based on time elapsed
    local delta = now - last
    if delta > 0 then
        local refill = delta * refill_rate
        tokens = math.min(capacity, tokens + refill)
        last = now
    end
end

local allowed = 0

-- Check if we have enough tokens to allow the request
if tokens >= 1 then
    tokens = tokens - 1
    allowed = 1
end

-- Save updated state back to Redis
redis.call("HMSET", key,
    "tokens", tokens,
    "last", last
)

redis.call("PEXPIRE", key, ttl)

-- Return an array: [allowed, remaining]
-- allowed will be 1 (true) or 0 (false)
return { allowed, tokens }
`
