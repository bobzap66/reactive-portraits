obs = obslua
local audio, target, mode, ending = '', '', 'single', 'Starting Soon'
local intro, tolerance = 62, 1.5
local last_text, phase, prev_time, prev_duration, seen, active_before, finished = nil, 1, nil, nil, false, false, false

-- Optional Windows localhost bridge; never changes OBS scenes or audio.
local bridge_enabled, campaign, scene, key = false, '', '', ''
local sent_complete, last_send, last_error = false, -100, nil
local logged_success = false
local last_config_log, last_mapping_log = nil, nil
local ffi, net
local ok, f = pcall(require, 'ffi')
if ok then
    ffi = f
    local loaded, lib = pcall(function()
        ffi.cdef[[
        void* __stdcall InternetOpenA(const char*, unsigned long, const char*, const char*, unsigned long);
        void* __stdcall InternetConnectA(void*, const char*, unsigned short, const char*, const char*, unsigned long, unsigned long, uintptr_t);
        void* __stdcall HttpOpenRequestA(void*, const char*, const char*, const char*, const char*, const char**, unsigned long, uintptr_t);
        int __stdcall InternetSetOptionA(void*, unsigned long, void*, unsigned long);
        int __stdcall HttpSendRequestA(void*, const char*, unsigned long, void*, unsigned long);
        int __stdcall HttpQueryInfoA(void*, unsigned long, void*, unsigned long*, unsigned long*);
        int __stdcall InternetCloseHandle(void*);
        ]]
        return ffi.load('wininet')
    end)
    if loaded then net = lib end
end
local function json_string(v)
    return '"' .. v:gsub('[%z\1-\31\\"]', function(c)
        if c == '"' or c == '\\' then return '\\' .. c end
        return string.format('\\u%04x', c:byte())
    end) .. '"'
end
local function post(kind, ms)
    if not net then return false, 'Windows HTTP library unavailable' end
    if key == '' or key:find('[\r\n]') or campaign == '' or scene == '' then return false, 'Bridge settings incomplete' end
    local h, c, r
    local success, result, reason = pcall(function()
        h = net.InternetOpenA('OBS countdown', 1, nil, nil, 0)
        if h == nil then return false, 'Local HTTP initialization failed' end
        local timeout = ffi.new('unsigned long[1]', 500)
        for _, opt in ipairs({2, 5, 6}) do net.InternetSetOptionA(h, opt, timeout, 4) end
        c = net.InternetConnectA(h, '127.0.0.1', 8766, nil, nil, 3, 0, 0)
        if c == nil then return false, 'Local connection failed' end
        -- NO_CACHE_WRITE | RELOAD | NO_AUTO_REDIRECT | NO_COOKIES | NO_UI
        r = net.HttpOpenRequestA(c, 'POST', '/api/obs/cue/' .. kind, nil, nil, nil, 0x84200200, 0)
        if r == nil then return false, 'Local request failed' end
        for _, opt in ipairs({2, 5, 6}) do net.InternetSetOptionA(r, opt, timeout, 4) end
        local body = '{"campaign":' .. json_string(campaign) .. ',"scene":' .. json_string(scene)
        if ms ~= nil then body = body .. ',"remainingMs":' .. tostring(ms) end
        body = body .. '}'
        local headers = 'Authorization: Bearer ' .. key .. '\r\nContent-Type: application/json\r\n'
        local data = ffi.new('char[?]', #body + 1, body)
        if net.HttpSendRequestA(r, headers, #headers, data, #body) == 0 then return false, 'Local HTTP send failed' end
        local status, size = ffi.new('unsigned long[1]'), ffi.new('unsigned long[1]', 4)
        if net.HttpQueryInfoA(r, 0x20000013, status, size, nil) == 0 then return false, 'No HTTP status' end
        return status[0] == 204, 'HTTP ' .. tostring(tonumber(status[0]))
    end)
    if r ~= nil then net.InternetCloseHandle(r) end
    if c ~= nil then net.InternetCloseHandle(c) end
    if h ~= nil then net.InternetCloseHandle(h) end
    if not success then return false, 'Local HTTP library error (FFI call failed)' end
    return result, reason
end
local function publish(ms, complete)
    if not bridge_enabled or (complete and sent_complete) then return end
    local now = obs.os_gettime_ns and tonumber(obs.os_gettime_ns()) / 1000000000 or os.time()
    if not complete and now - last_send < 2 then return end
    if complete and now - last_send < 1 then return end
    last_send = now
    local good, err = post(complete and 'intro-complete' or 'intro-countdown', ms)
    if good then
        if not logged_success or complete then
            obs.script_log(obs.LOG_INFO, complete and 'Reactive Portraits: completion accepted (HTTP 204)' or 'Reactive Portraits: countdown accepted (HTTP 204)')
            logged_success = true
        end
        last_error = nil
        if complete then sent_complete = true end
    elseif err ~= last_error then
        obs.script_log(obs.LOG_WARNING, 'Reactive Portraits intro: ' .. tostring(err))
        last_error = err
    end
end

local function reset()
    phase, prev_time, prev_duration, seen, finished = 1, nil, nil, false, false
    sent_complete, last_send, last_error = false, -100, nil
    logged_success = false
end
local function display(value)
    local s = obs.obs_get_source_by_name(target)
    if s == nil then return end
    if value ~= last_text then
        local d = obs.obs_data_create()
        obs.obs_data_set_string(d, 'text', value)
        obs.obs_source_update(s, d)
        obs.obs_data_release(d)
        last_text = value
    end
    obs.obs_source_release(s)
end
local function clock(seconds)
    local n = math.max(0, math.ceil(seconds))
    return string.format('%02d:%02d', math.floor(n / 60), n % 60)
end
local function tick()
    if audio == '' or target == '' or audio == target then return end
    local s = obs.obs_get_source_by_name(audio)
    if s == nil then return end
    local active = obs.obs_source_active(s)
    local state = obs.obs_source_media_get_state(s)
    local duration = obs.obs_source_media_get_duration(s) / 1000
    local time = obs.obs_source_media_get_time(s) / 1000
    obs.obs_source_release(s)
    if not active then
        if active_before then reset(); last_text = nil end
        active_before = false
        return
    end
    if not active_before then reset(); last_text = nil end
    active_before = true
    if state == obs.OBS_MEDIA_STATE_PLAYING or state == obs.OBS_MEDIA_STATE_PAUSED then
        if duration <= 0 or time < 0 then return end
        if finished then reset() end
        if mode == 'playlist' then
            if phase == 1 and seen and prev_time and prev_duration then
                local wrapped = prev_time - time > 0.5 and prev_duration - prev_time <= 2
                local changed = math.abs(duration - prev_duration) > 0.5 and time < 3
                if (wrapped or changed) and math.abs(duration - intro) <= tolerance then phase = 2 end
            end
        end
        seen = true
        prev_time, prev_duration = time, duration
        local remaining = math.max(0, duration - time)
        if mode == 'playlist' and phase == 1 then remaining = remaining + intro end
        display(clock(remaining))
        publish(math.floor(remaining * 1000 + 0.5), false)
    elseif state == obs.OBS_MEDIA_STATE_ENDED then
        if seen and (mode == 'single' or phase == 2) then
            finished = true
            display(ending)
            publish(nil, true)
        elseif not seen then
            display('--:--')
        end
    elseif state == obs.OBS_MEDIA_STATE_STOPPED or state == obs.OBS_MEDIA_STATE_NONE then
        if finished then display(ending); publish(nil, true) else display('--:--') end
    end
end
function script_description()
    return 'Countdown for a single OBS media file or a two-track VLC playlist. Playlist mode assumes playback begins with track one and the second track has the configured duration. Updates text and optionally publishes local intro cues; never switches scenes or changes audio/stream state.'
end
function script_defaults(s)
    obs.obs_data_set_default_string(s, 'mode', 'single')
    obs.obs_data_set_default_string(s, 'audio', 'Starting Soon Music')
    obs.obs_data_set_default_string(s, 'target', 'Countdown')
    obs.obs_data_set_default_string(s, 'ending', 'Starting Soon')
    obs.obs_data_set_default_int(s, 'intro', 62)
    obs.obs_data_set_default_double(s, 'tolerance', 1.5)
end
function script_properties()
    local p = obs.obs_properties_create()
    local m = obs.obs_properties_add_list(p, 'mode', 'Playback mode', obs.OBS_COMBO_TYPE_LIST, obs.OBS_COMBO_FORMAT_STRING)
    obs.obs_property_list_add_string(m, 'Single audio file', 'single')
    obs.obs_property_list_add_string(m, 'Two-track VLC playlist', 'playlist')
    local a = obs.obs_properties_add_list(p, 'audio', 'Audio source', obs.OBS_COMBO_TYPE_EDITABLE, obs.OBS_COMBO_FORMAT_STRING)
    local t = obs.obs_properties_add_list(p, 'target', 'Countdown text source', obs.OBS_COMBO_TYPE_EDITABLE, obs.OBS_COMBO_FORMAT_STRING)
    local sources = obs.obs_enum_sources()
    if sources ~= nil then
        for _, s in ipairs(sources) do
            local id, name = obs.obs_source_get_id(s), obs.obs_source_get_name(s)
            if id == 'ffmpeg_source' or id == 'vlc_source' then obs.obs_property_list_add_string(a, name, name) end
            if string.find(id, 'text_gdiplus', 1, true) or string.find(id, 'text_ft2_source', 1, true) then obs.obs_property_list_add_string(t, name, name) end
        end
        obs.source_list_release(sources)
    end
    obs.obs_properties_add_int(p, 'intro', 'Final track length (seconds; playlist only)', 1, 3600, 1)
    obs.obs_properties_add_float(p, 'tolerance', 'Final track duration tolerance (seconds)', 0.1, 10, 0.1)
    obs.obs_properties_add_text(p, 'ending', 'Text when playback ends', obs.OBS_TEXT_DEFAULT)
    obs.obs_properties_add_bool(p, 'bridge_enabled', 'Publish intro cues to Reactive Portraits')
    obs.obs_properties_add_text(p, 'bridge_campaign', 'Reactive Portraits campaign ID', obs.OBS_TEXT_DEFAULT)
    obs.obs_properties_add_text(p, 'bridge_scene', 'Exact mapped OBS intro scene name', obs.OBS_TEXT_DEFAULT)
    obs.obs_properties_add_text(p, 'bridge_key', 'Local cue credential (Bearer token only)', obs.OBS_TEXT_PASSWORD)
    return p
end
function script_update(s)
    audio = obs.obs_data_get_string(s, 'audio')
    target = obs.obs_data_get_string(s, 'target')
    mode = obs.obs_data_get_string(s, 'mode')
    ending = obs.obs_data_get_string(s, 'ending')
    intro = obs.obs_data_get_int(s, 'intro')
    tolerance = obs.obs_data_get_double(s, 'tolerance')
    bridge_enabled = obs.obs_data_get_bool(s, 'bridge_enabled')
    campaign = obs.obs_data_get_string(s, 'bridge_campaign')
    scene = obs.obs_data_get_string(s, 'bridge_scene')
    key = obs.obs_data_get_string(s, 'bridge_key'):match('^%s*(.-)%s*$')
    key = key:gsub('^Bearer%s+', '')
    local status = 'Reactive Portraits bridge: ' .. (bridge_enabled and 'enabled' or 'disabled') .. '; HTTP library: ' .. (net and 'available' or 'unavailable') .. '; credential: ' .. (key ~= '' and 'set' or 'missing')
    if status ~= last_config_log then
        obs.script_log(obs.LOG_INFO, status)
        last_config_log = status
    end
    local mapping = bridge_enabled and ('Reactive Portraits mapping: ' .. campaign .. ' / ' .. scene) or nil
    if mapping and mapping ~= last_mapping_log then obs.script_log(obs.LOG_INFO, mapping) end
    last_mapping_log = mapping
    reset(); active_before = false; last_text = nil
    obs.timer_remove(tick)
    obs.timer_add(tick, 100)
end
function script_unload() obs.timer_remove(tick) end
