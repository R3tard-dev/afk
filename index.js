require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const mineflayer = require('mineflayer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'mc-secret',
    resave: false,
    saveUninitialized: false
}));

const activeBots = {};

// Bot Instance Logic
function createBotInstance(botData) {
    const { bot_instance_id, auth_type, credentials, name, server_host } = botData;
    const creds = typeof credentials === 'string' ? JSON.parse(credentials) : credentials;

    const bot = mineflayer.createBot({
        host: server_host || 'localhost',
        username: auth_type === 'offline' ? creds.username : creds.email,
        password: creds.password,
        auth: auth_type,
        version: false // Auto-detects MC version
    });

    bot.on('login', () => {
        io.to(bot_instance_id).emit('console', `[System] Connected to ${server_host} as ${bot.username}`);
        io.emit('status-update', { botId: bot_instance_id, status: 'online' });
    });

    bot.on('chat', (username, message) => {
        io.to(bot_instance_id).emit('console', `[Chat] ${username}: ${message}`);
    });

    bot.on('error', (err) => {
        io.to(bot_instance_id).emit('console', `[Error] ${err.message}`);
        io.emit('status-update', { botId: bot_instance_id, status: 'offline' });
    });

    bot.on('end', () => {
        io.to(bot_instance_id).emit('console', `[System] Disconnected from server.`);
        io.emit('status-update', { botId: bot_instance_id, status: 'offline' });
        delete activeBots[bot_instance_id];
    });

    activeBots[bot_instance_id] = bot;
}

// Routes
app.get('/', (req, res) => res.render('index', { error: null }));

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length > 0 && await bcrypt.compare(password, result.rows[0].password)) {
        req.session.userId = result.rows[0].id;
        return res.redirect('/dash');
    }
    res.render('index', { error: 'Invalid credentials.' });
});

app.get('/dash', async (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const bots = await pool.query('SELECT * FROM bots WHERE owner_id = $1', [req.session.userId]);
    const botsWithStatus = bots.rows.map(b => ({ ...b, status: activeBots[b.bot_instance_id] ? 'online' : 'offline' }));
    res.render('dash', { bots: botsWithStatus });
});

app.post('/create-bot', async (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const { name, auth_type, email, password, username, server_host } = req.body;
    const bot_id = uuidv4().substring(0, 8);
    const creds = auth_type === 'offline' ? { username } : { email, password };

    await pool.query(
        'INSERT INTO bots (owner_id, name, auth_type, credentials, bot_instance_id, server_host) VALUES ($1, $2, $3, $4, $5, $6)',
        [req.session.userId, name, auth_type, JSON.stringify(creds), bot_id, server_host]
    );
    res.redirect('/dash');
});

app.post('/start-bot/:id', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ success: false });
    const botId = req.params.id;
    if (activeBots[botId]) return res.json({ success: true });

    const result = await pool.query('SELECT * FROM bots WHERE bot_instance_id = $1 AND owner_id = $2', [botId, req.session.userId]);
    if (result.rows.length > 0) {
        createBotInstance(result.rows[0]);
        return res.json({ success: true });
    }
    res.json({ success: false });
});

app.post('/stop-bot/:id', (req, res) => {
    const botId = req.params.id;
    if (activeBots[botId]) {
        activeBots[botId].quit();
        delete activeBots[botId];
        io.emit('status-update', { botId: botId, status: 'offline' });
    }
    res.json({ success: true });
});

app.get('/:id/view', async (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const result = await pool.query('SELECT * FROM bots WHERE bot_instance_id = $1 AND owner_id = $2', [req.params.id, req.session.userId]);
    if (result.rows.length === 0) return res.redirect('/dash');
    res.render('view', { bot: result.rows[0], isOnline: !!activeBots[req.params.id] });
});

// Socket logic
io.on('connection', (socket) => {
    socket.on('join-bot-room', (botId) => socket.join(botId));
    socket.on('send-command', (data) => {
        if (activeBots[data.botId]) activeBots[data.botId].chat(data.command);
    });
});

server.listen(process.env.PORT || 3000);