const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const dbPath = process.env.VERCEL ? path.join('/tmp', 'db.json') : path.join(__dirname, 'db.json');

// Real DB starting from ZERO
if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify({
        stats: { totalUsers: 0, totalDownloads: 0, totalActiveUsers: 0, todayActiveUsers: 0, notificationClicks: 0, keysGeneratedToday: 0, keyGenSuccess: 0, keyGenFailed: 0, totalViewType: 0 },
        config: { 
            batchesApi: "https://cw-ut-apis-e37c22944d2f.herokuapp.com/api/batches", 
            subjectsApi: "https://cw-api-website.vercel.app/batch/{batchId}", 
            videosApi: "https://cw-api-website.vercel.app/batch?batchid={batchId}&topicid={topicId}&full=true", 
            pdfsApi: "https://cw-api-website.vercel.app/batch?batchid={batchId}&topicid={topicId}&full=true",
            resolverApi: "https://cw-vid-virid.vercel.app/get_video_details?name={videoId}",
            isUpdateRequired: false,
            updateLink: "https://play.google.com/store",
            maintenanceMode: false,
            joinChannelEnabled: false,
            joinChannelLink: "https://t.me/yourchannel",
            batchImageUrl: "https://i.postimg.cc/s2MMkMr4/file-00000000cf8872089fe9cb392228cd4d.png",
            splashImageUrl: "https://i.postimg.cc/s2MMkMr4/file-00000000cf8872089fe9cb392228cd4d.png",
            alwaysUpdate: false,
            securityPin: ""
        },
        dailyStats: [], // format: { date: '21 May', activeUsers: 1 }
        users: {}, // format: { userId: { name, avatar, firstActive, lastActive, totalActiveSeconds, isOnline, ip, activities: [] } }
        bannedIps: [],
        notifications: [],
        freeAccessUsers: [], // format: [userId1, userId2...]
        chatHistory: [] // format: { id, senderId, senderName, text, imageUrl, timestamp, isAdmin }
    }));
} else {
    // Migrate to support new fields
    try {
        const currentData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        let modified = false;
        if (!currentData.bannedIps) { currentData.bannedIps = []; modified = true; }
        if (!currentData.notifications) { currentData.notifications = []; modified = true; }
        if (!currentData.freeAccessUsers) { currentData.freeAccessUsers = []; modified = true; }
        if (!currentData.chatHistory) { currentData.chatHistory = []; modified = true; }
        if (currentData.config && currentData.config.chatEnabled === undefined) {
             currentData.config.chatEnabled = true;
             modified = true;
        }
        if (currentData.stats && currentData.stats.keysGeneratedToday === undefined) {
            currentData.stats.keysGeneratedToday = 0;
            currentData.stats.keyGenSuccess = 0;
            currentData.stats.keyGenFailed = 0;
            currentData.stats.totalViewType = 0;
            modified = true;
        }
        if (currentData.config) {
            if (currentData.config.alwaysUpdate === undefined) {
                currentData.config.alwaysUpdate = false;
                modified = true;
            }
            if (currentData.config.resolverApi === undefined || currentData.config.resolverApi.includes("example.com")) {
                currentData.config.resolverApi = "https://cw-vid-virid.vercel.app/get_video_details?name={videoId}";
                modified = true;
            }
            if (currentData.config.batchesApi === undefined || currentData.config.batchesApi.includes("example.com") || currentData.config.batchesApi.includes("herokuapp.com")) {
                currentData.config.batchesApi = "https://xxadmin-raj.codxraj.site/api/batches";
                modified = true;
            }
            if (currentData.config.subjectsApi === undefined || currentData.config.subjectsApi.includes("example.com")) {
                currentData.config.subjectsApi = "https://cw-api-website.vercel.app/batch/{batchId}";
                modified = true;
            }
            if (currentData.config.videosApi === undefined || currentData.config.videosApi.includes("example.com")) {
                currentData.config.videosApi = "https://cw-api-website.vercel.app/batch?batchid={batchId}&topicid={topicId}&full=true";
                modified = true;
            }
            if (currentData.config.pdfsApi === undefined || currentData.config.pdfsApi.includes("example.com")) {
                currentData.config.pdfsApi = "https://cw-api-website.vercel.app/batch?batchid={batchId}&topicid={topicId}&full=true";
                modified = true;
            }
            if (currentData.config.batchImageUrl === undefined || currentData.config.batchImageUrl.includes("picsum.photos")) {
                currentData.config.batchImageUrl = "https://i.postimg.cc/s2MMkMr4/file-00000000cf8872089fe9cb392228cd4d.png";
                modified = true;
            }
            if (currentData.config.splashImageUrl === undefined) {
                currentData.config.splashImageUrl = "https://i.postimg.cc/s2MMkMr4/file-00000000cf8872089fe9cb392228cd4d.png";
                modified = true;
            }
            if (currentData.config.securityPin === undefined) {
                currentData.config.securityPin = "";
                modified = true;
            }
        }
        if (!currentData.users) {
            currentData.users = {};
            modified = true;
        }
        if (modified) {
            fs.writeFileSync(dbPath, JSON.stringify(currentData, null, 2));
        }
    } catch (e) {
        console.error("Migration error", e);
    }
}

const getDb = () => JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const saveDb = (data) => fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));

function broadcast(action, payload, toAdminOnly = false) {
    const msg = JSON.stringify({ action, payload });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            if (toAdminOnly && !client.isAdmin) return;
            client.send(msg);
        }
    });
}

function getTodayStr() {
    const d = new Date();
    return `${d.getDate()} ${d.toLocaleString('default', { month: 'short' })}`;
}

let connectedAppCounter = 0;

wss.on('connection', (ws, req) => {
    const isApp = req.url.includes('?type=app');
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (isApp) {
        const db = getDb();
        if (db.bannedIps && db.bannedIps.includes(ip)) {
            ws.send(JSON.stringify({ action: 'update_config', payload: { maintenanceMode: true, splashImageUrl: "BANNED" } }));
            return ws.terminate();
        }

        connectedAppCounter++;
        db.stats.totalActiveUsers++;
        db.stats.todayActiveUsers++;
        
        // Push daily stat
        const today = getTodayStr();
        let todayStat = db.dailyStats.find(s => s.date === today);
        if(!todayStat) {
            todayStat = { date: today, activeUsers: 0 };
            db.dailyStats.push(todayStat);
            if(db.dailyStats.length > 7) db.dailyStats.shift();
        }
        todayStat.activeUsers++;

        saveDb(db);
        
        // Notify admin instantly
        broadcast('update_stats', { 
            stats: db.stats, 
            dailyStats: db.dailyStats,
            connectedNow: connectedAppCounter 
        }, true);

        // Send latest config to this newly connected app
        ws.send(JSON.stringify({ 
            action: 'update_config', 
            payload: { 
                ...db.config, 
                freeAccessUsers: db.freeAccessUsers || [],
                chatHistory: (db.chatHistory || []).slice(-50)
            } 
        }));
        
        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                if (data.action === 'identify' && data.payload) {
                    const { userId, name, avatar } = data.payload;
                    ws.userId = userId;
                    ws.connectedAt = Date.now();

                    const db = getDb();
                    if (!db.users) db.users = {};

                    const firstActive = db.users[userId] ? db.users[userId].firstActive : Date.now();
                    const accumulated = db.users[userId] ? db.users[userId].totalActiveSeconds || 0 : 0;

                    db.users[userId] = {
                        name: name || "Anonymous",
                        avatar: avatar || "Neon Astronaut",
                        firstActive: firstActive,
                        lastActive: Date.now(),
                        totalActiveSeconds: accumulated,
                        isOnline: true,
                        ip: ip,
                        activities: db.users[userId] ? db.users[userId].activities || [] : []
                    };
                    saveDb(db);

                    // Notify admins of new user lists
                    broadcast('update_users', { users: db.users }, true);
                } else if (data.action === 'track_activity' && data.payload) {
                    const { userId, activity } = data.payload;
                    if (userId && activity) {
                        const db = getDb();
                        if (db.users && db.users[userId]) {
                            db.users[userId].currentActivity = activity;
                            db.users[userId].lastActive = Date.now();
                            db.users[userId].isOnline = true;
                            if (!db.users[userId].activities) db.users[userId].activities = [];
                            db.users[userId].activities.push({ text: activity, time: Date.now() });
                            if (db.users[userId].activities.length > 50) db.users[userId].activities.shift();
                            saveDb(db);
                            broadcast('update_users', { users: db.users }, true);
                        }
                    }
                } else if (data.action === 'track_key_gen' && data.payload) {
                    const { userId, success, type } = data.payload;
                    const db = getDb();
                    
                    if (type === 'Initiated Generation') {
                        db.stats.keysGeneratedToday++;
                    } else if (success) {
                        db.stats.keyGenSuccess++;
                    } else {
                        db.stats.keyGenFailed++;
                    }

                    if (userId && db.users[userId]) {
                         if (!db.users[userId].activities) db.users[userId].activities = [];
                         db.users[userId].activities.push({ text: `Key Gen: ${success ? 'Success' : 'Failed'} (${type})`, time: Date.now() });
                    }
                    saveDb(db);
                    broadcast('update_stats', { stats: db.stats, dailyStats: db.dailyStats, connectedNow: connectedAppCounter }, true);
                    broadcast('update_users', { users: db.users }, true);
                } else if (data.action === 'track_click' && data.payload) {
                    const { userId, notificationId } = data.payload;
                    const db = getDb();
                    db.stats.notificationClicks = (db.stats.notificationClicks || 0) + 1;
                    if (notificationId && db.notifications) {
                        const notif = db.notifications.find(n => n.id == notificationId);
                        if (notif) {
                            if (!notif.clickedBy) notif.clickedBy = [];
                            if (!notif.clickedBy.includes(userId)) {
                                notif.clickedBy.push(userId);
                            }
                        }
                    }
                    if (userId && db.users[userId]) {
                        if (!db.users[userId].activities) db.users[userId].activities = [];
                        db.users[userId].activities.push({ text: "Clicked Notification", time: Date.now() });
                    }
                    saveDb(db);
                    broadcast('update_stats', { stats: db.stats, dailyStats: db.dailyStats, connectedNow: connectedAppCounter }, true);
                    broadcast('update_users', { users: db.users }, true);
                    broadcast('init_admin', { ...db, connectedNow: connectedAppCounter }, true);
                } else if (data.action === 'track_delivered' && data.payload) {
                    const { userId, notificationId } = data.payload;
                    const db = getDb();
                    if (notificationId && db.notifications) {
                        const notif = db.notifications.find(n => n.id == notificationId);
                        if (notif) {
                            if (!notif.deliveredTo) notif.deliveredTo = [];
                            if (!notif.deliveredTo.includes(userId)) {
                                notif.deliveredTo.push(userId);
                            }
                        }
                    }
                    saveDb(db);
                    broadcast('init_admin', { ...db, connectedNow: connectedAppCounter }, true);
                } else if (data.action === 'heartbeat' && data.payload) {
                    const { userId } = data.payload;
                    if (userId) {
                        const db = getDb();
                        if (db.users && db.users[userId]) {
                            db.users[userId].lastActive = Date.now();
                            db.users[userId].isOnline = true;
                            // Add periodic session increments if they stay active
                            if (ws.connectedAt) {
                                const currentNow = Date.now();
                                const diff = Math.round((currentNow - ws.connectedAt) / 1000);
                                if (diff > 0) {
                                    db.users[userId].totalActiveSeconds = (db.users[userId].totalActiveSeconds || 0) + diff;
                                    ws.connectedAt = currentNow; // Reset segment
                                }
                            }
                            saveDb(db);
                            broadcast('update_users', { users: db.users }, true);
                        }
                    }
                } else if (data.action === 'send_chat_message' && data.payload) {
                    const db = getDb();
                    // Block if chat is globally off unless admin
                    if (!db.config.chatEnabled && !ws.isAdmin) return;

                    const msg = {
                        id: Date.now() + "-" + Math.random().toString(36).substr(2, 5),
                        senderId: data.payload.senderId || "Unknown",
                        senderName: data.payload.senderName || "Anonymous",
                        text: data.payload.text || "",
                        imageUrl: data.payload.imageUrl || null,
                        timestamp: Date.now(),
                        isAdmin: ws.isAdmin || false
                    };
                    
                    db.chatHistory = db.chatHistory || [];
                    db.chatHistory.push(msg);
                    if (db.chatHistory.length > 200) db.chatHistory.shift();
                    saveDb(db);
                    
                    // Broadcast to everyone
                    broadcast('new_chat_message', msg, false);
                }
            } catch (e) {
                console.error("App socket parse error", e);
            }
        });

        ws.on('close', () => {
            connectedAppCounter = Math.max(0, connectedAppCounter - 1);
            
            const db = getDb();
            if (ws.userId && db.users && db.users[ws.userId]) {
                db.users[ws.userId].isOnline = false;
                db.users[ws.userId].lastActive = Date.now();
                if (ws.connectedAt) {
                    const elapsed = Math.round((Date.now() - ws.connectedAt) / 1000);
                    if (elapsed > 0) {
                        db.users[ws.userId].totalActiveSeconds = (db.users[ws.userId].totalActiveSeconds || 0) + elapsed;
                    }
                }
                saveDb(db);
                // Broadcast updated user registry
                broadcast('update_users', { users: db.users }, true);
            }
            
            broadcast('update_stats', { stats: db.stats, dailyStats: db.dailyStats, connectedNow: connectedAppCounter }, true);
        });
    } else {
        // Admin connected
        ws.isAdmin = true;
        const db = getDb();
        ws.send(JSON.stringify({ 
            action: 'init_admin', 
            payload: { 
                ...db, 
                connectedNow: connectedAppCounter,
                chatHistory: (db.chatHistory || []).slice(-100) 
            } 
        }));
        
        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                if (data.action === 'send_notification') {
                    const db = getDb();
                    const notifId = Date.now();
                    const newNotif = {
                        id: notifId,
                        title: data.payload.title,
                        body: data.payload.body,
                        link: data.payload.link,
                        sentToCount: connectedAppCounter,
                        deliveredTo: [],
                        clickedBy: [],
                        timestamp: Date.now()
                    };
                    db.notifications.push(newNotif);
                    if (db.notifications.length > 20) db.notifications.shift();
                    saveDb(db);
                    
                    // BROADCAST NOTIFICATION TO ALL CONNECTED APPS
                    broadcast('notification', { ...data.payload, id: notifId }, false);
                    broadcast('init_admin', { ...db, connectedNow: connectedAppCounter }, true);
                } else if (data.action === 'update_config') {
                    const db = getDb();
                    db.config = data.payload;
                    saveDb(db);
                    // SEND CONFIG TO ALL APPS
                    broadcast('update_config', { ...db.config, freeAccessUsers: db.freeAccessUsers || [] }, false);
                } else if (data.action === 'ban_user') {
                    const { userId } = data.payload;
                    const db = getDb();
                    if (db.users[userId] && db.users[userId].ip) {
                        if (!db.bannedIps.includes(db.users[userId].ip)) {
                            db.bannedIps.push(db.users[userId].ip);
                            saveDb(db);
                            broadcast('init_admin', { ...db, connectedNow: connectedAppCounter }, true);
                        }
                    }
                } else if (data.action === 'unban_ip') {
                    const { ip } = data.payload;
                    const db = getDb();
                    db.bannedIps = db.bannedIps.filter(i => i !== ip);
                    saveDb(db);
                    broadcast('init_admin', { ...db, connectedNow: connectedAppCounter }, true);
                } else if (data.action === 'grant_free_access') {
                    const { userIds } = data.payload;
                    const db = getDb();
                    if (!db.freeAccessUsers) db.freeAccessUsers = [];
                    userIds.forEach(id => {
                        if (!db.freeAccessUsers.includes(id)) db.freeAccessUsers.push(id);
                    });
                    saveDb(db);
                    broadcast('init_admin', { ...db, connectedNow: connectedAppCounter }, true);
                    // Broadcast updated free list to apps
                    broadcast('update_config', { ...db.config, freeAccessUsers: db.freeAccessUsers }, false); 
                } else if (data.action === 'revoke_free_access') {
                    const { userId } = data.payload;
                    const db = getDb();
                    db.freeAccessUsers = (db.freeAccessUsers || []).filter(id => id !== userId);
                    saveDb(db);
                    broadcast('init_admin', { ...db, connectedNow: connectedAppCounter }, true);
                    broadcast('update_config', { ...db.config, freeAccessUsers: db.freeAccessUsers }, false);
                }
            } catch(e) {
                console.error("Parse Error Admin WS", e);
            }
        });
    }
});

// For first time launch only
app.post('/api/app_installed', (req, res) => {
    const db = getDb();
    db.stats.totalDownloads++;
    db.stats.totalUsers++;
    saveDb(db);
    broadcast('update_stats', { stats: db.stats, dailyStats: db.dailyStats, connectedNow: connectedAppCounter }, true);
    res.json({ success: true });
});

// Track notification clicks
app.post('/api/stats/click', (req, res) => {
    const db = getDb();
    db.stats.notificationClicks = (db.stats.notificationClicks || 0) + 1;
    saveDb(db);
    broadcast('update_stats', { stats: db.stats, dailyStats: db.dailyStats, connectedNow: connectedAppCounter }, true);
    res.json({ success: true });
});

// Robust HTTP REST endpoint fallback for notification broadcast
app.post('/api/send_notification', (req, res) => {
    const { title, body, link } = req.body;
    if (!title || !body) {
        return res.status(400).json({ error: "Title and body are required" });
    }
    broadcast('notification', { title, body, link }, false);
    res.json({ success: true, message: "Broadcasted via API" });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Real-Time WebSocket Server running on port ${PORT}`);
});
