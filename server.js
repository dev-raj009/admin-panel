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
            batchesApi: "https://example.com/api/v1/batches", 
            subjectsApi: "https://example.com/api/v1/subjects", 
            videosApi: "https://example.com/api/v1/videos", 
            pdfsApi: "https://example.com/api/v1/pdfs",
            isUpdateRequired: false,
            updateLink: "https://play.google.com/store"
        },
        dailyStats: [] // format: { date: '21 May', activeUsers: 1 }
    }));
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
        
        ws.on('close', () => {
            connectedAppCounter = Math.max(0, connectedAppCounter - 1);
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
