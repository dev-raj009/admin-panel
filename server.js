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
        stats: { totalUsers: 0, totalDownloads: 0, totalActiveUsers: 0, todayActiveUsers: 0, notificationClicks: 0 },
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
            alwaysUpdate: false
        },
        dailyStats: [], // format: { date: '21 May', activeUsers: 1 }
        users: {} // format: { userId: { name, avatar, firstActive, lastActive, totalActiveSeconds, isOnline } }
    }));
} else {
    // Migrate to support resolverApi, alwaysUpdate and users structure safely
    try {
        const currentData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        let modified = false;
        if (currentData.config) {
            if (currentData.config.alwaysUpdate === undefined) {
                currentData.config.alwaysUpdate = false;
                modified = true;
            }
            if (currentData.config.resolverApi === undefined || currentData.config.resolverApi.includes("example.com")) {
                currentData.config.resolverApi = "https://cw-vid-virid.vercel.app/get_video_details?name={videoId}";
                modified = true;
            }
            if (currentData.config.batchesApi === undefined || currentData.config.batchesApi.includes("example.com")) {
                currentData.config.batchesApi = "https://cw-ut-apis-e37c22944d2f.herokuapp.com/api/batches";
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
    
    if (isApp) {
        connectedAppCounter++;
        const db = getDb();
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
        ws.send(JSON.stringify({ action: 'update_config', payload: db.config }));
        
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
                        isOnline: true
                    };
                    saveDb(db);

                    // Notify admins of new user lists
                    broadcast('update_users', { users: db.users }, true);
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
            payload: { ...db, connectedNow: connectedAppCounter } 
        }));
        
        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                if (data.action === 'send_notification') {
                    // BROADCAST NOTIFICATION TO ALL CONNECTED APPS
                    broadcast('notification', data.payload, false);
                } else if (data.action === 'update_config') {
                    const db = getDb();
                    db.config = data.payload;
                    saveDb(db);
                    // SEND CONFIG TO ALL APPS
                    broadcast('update_config', db.config, false);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Real-Time WebSocket Server running on port ${PORT}`);
});
