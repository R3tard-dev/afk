require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const mineflayer = require('mineflayer');
const socks = require('socks').SocksClient;
const { ProxyAgent } = require('proxy-agent');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'mc-secret',
    resave: false,
    saveUninitialized: false
}));

const activeBots = {};

function createBotInstance(botData) {
    const { bot_instance_id, auth_type, credentials, name, server_host, proxy } = botData;
    const creds = typeof credentials === 'string' ? JSON.parse(credentials) : credentials;
    
    const [host, portStr] = server_host.includes(':') ? server_host.split(':') : [server_host, '25565'];
    const port = parseInt(portStr);

    const botOptions = {
        host: host,
        port: port,
        username: auth_type === 'offline' ? creds.username : creds.email,
        auth: auth_type,
        hideErrors: true,
        // Handler for Device Flow (Microsoft Auth Link)
        onMsaCode: (data) => {
            io.to(bot_instance_id).emit('console', `<br><span class="text-white bg-blue-600 px-2 py-1 rounded">ACTION REQUIRED</span>`);
            io.to(bot_instance_id).emit('console', `Go to: <a href="${data.verification_uri}" target="_blank" class="underline text-blue-400">${data.verification_uri}</a>`);
            io.to(bot_instance_id).emit('console', `Enter Code: <span class="font-black text-white text-lg">${data.user_code}</span><br>`);
        }
    };

    // If password exists, use it. If not, Mineflayer defaults to Device Flow.
    if (creds.password && auth_type === 'microsoft') {
        botOptions.password = creds.password;
    }

    if (proxy && proxy.includes(':')) {
        const [proxyHost, proxyPort] = proxy.split(':');
        botOptions.connect = (client) => {
            socks.createConnection({
                proxy: { host: proxyHost, port: parseInt(proxyPort), type: 5 },
                command: 'connect',
                destination: { host: host, port: port }
            }, (err, info) => {
                if (err) {
                    io.to(bot_instance_id).emit('console', `[Proxy Error] ${err.message}`);
                    return;
                }
                client.setSocket(info.socket);
                client.emit('connect');
            });
        };
        botOptions.agent = new ProxyAgent(`socks5://${proxyHost}:${proxyPort}`);
    }

    const bot = mineflayer.createBot(botOptions);

    bot.on('login', () => {
        io.to(bot_instance_id).emit('console', `[System] Logged in as ${bot.username}`);
        io.emit('status-update', { botId: bot_instance_id, status: 'online' });
    });

    bot.on('error', (err) => {
        io.to(bot_instance_id).emit('console', `[Error] ${err.message}`);
    });

    bot.on('end', () => {
        io.emit('status-update', { botId: bot_instance_id, status: 'offline' });
        delete activeBots[bot_instance_id];
    });

    activeBots[bot_instance_id] = bot;
}

// Routes
app.get('/', (req, res) => res.render('index', { error: null }));

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length > 0 && await bcrypt.compare(password, result.rows[0].password)) {
            req.session.userId = result.rows[0].id;
            return res.redirect('/dash');
        }
        res.render('index', { error: 'Invalid login.' });
    } catch(e) { res.render('index', { error: 'DB Error' }); }
});

app.get('/dash', async (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const bots = await pool.query('SELECT * FROM bots WHERE owner_id = $1', [req.session.userId]);
    const botsWithStatus = bots.rows.map(b => ({ ...b, status: activeBots[b.bot_instance_id] ? 'online' : 'offline' }));
    res.render('dash', { bots: botsWithStatus });
});

app.post('/create-bot', async (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const { name, auth_type, email, password, username, server_host, proxy } = req.body;
    const bot_id = uuidv4().substring(0, 8);
    const creds = auth_type === 'offline' ? { username } : { email, password };

    await pool.query(
        'INSERT INTO bots (owner_id, name, auth_type, credentials, bot_instance_id, server_host, proxy) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [req.session.userId, name, auth_type, JSON.stringify(creds), bot_id, server_host, proxy]
    );
    res.redirect('/dash');
});

app.post('/start-bot/:id', async (req, res) => {
    const botId = req.params.id;
    if (activeBots[botId]) return res.json({ success: true });
    const result = await pool.query('SELECT * FROM bots WHERE bot_instance_id = $1', [botId]);
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
    const result = await pool.query('SELECT * FROM bots WHERE bot_instance_id = $1', [req.params.id]);
    res.render('view', { bot: result.rows[0], isOnline: !!activeBots[req.params.id] });
});

io.on('connection', (socket) => {
    socket.on('join-bot-room', (botId) => socket.join(botId));
    socket.on('send-command', (data) => {
        if (activeBots[data.botId]) activeBots[data.botId].chat(data.command);
    });
});

server.listen(process.env.PORT || 3000);