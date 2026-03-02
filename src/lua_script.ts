export default `
local key = KEYS[1]

local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local data = redis.call("HMGET", key, "tokens", "last")

local tokens = tonumber(data[1])
local last = tonumber(data[2])

if tokens == nil then
    tokens = capacity
    last = now
end

local delta = now - last
if delta > 0 then
    local refill = delta * refill_rate
    tokens = math.min(capacity, tokens + refill)
    last = now
end

local allowed = 0

if tokens >= 1 then
    tokens = tokens - 1
    allowed = 1
end

redis.call("HMSET", key,
    "tokens", tokens,
    "last", last
)

redis.call("PEXPIRE", key, 60000)

return allowed
`
