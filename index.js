const mineflayer = require('mineflayer');
const express = require('express');

const app = express();
const HTTP_PORT = 8080;
let bot; // Hoisted to allow the health check to access bot state

const botArgs = {
    host: 'donutsmp.net', 
    port: 25565,
    auth: 'microsoft',
    username: 'play074@outlook.com',
    version: false,
};

// --- Health Check Server ---
app.get('/health', (req, res) => {
    // Returns 200 OK if the script is alive
    // Includes metadata about the Minecraft bot connection
    res.status(200).json({
        status: 'online',
        uptime: Math.floor(process.uptime()) + 's',
        minecraft: {
            connected: !!(bot && bot.entity),
            username: bot ? bot.username : 'not_logged_in'
        }
    });
});

app.listen(HTTP_PORT, () => {
    console.log(`[System] Health check server active on port ${HTTP_PORT}`);
});

// --- Bot Logic ---
function createBot() {
    bot = mineflayer.createBot(botArgs);

    bot.on('login', () => {
        console.log(`[Success] Logged in as ${bot.username}`);
    });

    bot.once('spawn', () => {
        console.log('✅ Bot spawned. Starting Anti-AFK routines.');
        
        setInterval(() => {
            const yaw = Math.random() * Math.PI * 2;
            bot.look(yaw, 0); 
            
            bot.setControlState('jump', true);
            setTimeout(() => bot.setControlState('jump', false), 500);
        }, 20000);
    });

    bot.on('kicked', (reason) => console.log(`[Kicked] ${reason}`));
    bot.on('error', (err) => console.log(`[Error] ${err.message}`));

    bot.on('end', () => {
        console.log('❌ Disconnected. Attempting to reconnect in 15 seconds...');
        setTimeout(createBot, 15000);
    });
}

createBot();