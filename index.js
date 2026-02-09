const mineflayer = require('mineflayer');

const botArgs = {
    host: 'donutsmp.net', 
    port: 25565,
    auth: 'microsoft',      // Required for Microsoft accounts
    username: 'play074@outlook.com', // Your Microsoft account email
    version: false,         // Auto-detects version
    // profilesFolder: './cache' // Optional: saves login data here
};

function createBot() {
    const bot = mineflayer.createBot(botArgs);

    // This event triggers during the login process
    bot.on('login', () => {
        console.log(`[Success] Logged in as ${bot.username}`);
    });

    bot.once('spawn', () => {
        console.log('✅ Bot spawned. Starting Anti-AFK routines.');
        
        // Anti-AFK: Moves the bot slightly and jumps
        setInterval(() => {
            const yaw = Math.random() * Math.PI * 2;
            bot.look(yaw, 0); // Look in a random horizontal direction
            
            bot.setControlState('jump', true);
            setTimeout(() => bot.setControlState('jump', false), 500);
        }, 20000); // Trigger every 20 seconds
    });

    // Handle being kicked or disconnected
    bot.on('kicked', (reason) => console.log(`[Kicked] ${reason}`));
    bot.on('error', (err) => {
        if (err.code === 'ECONNREFUSED') {
            console.log(`[Error] Failed to connect to ${err.address}`);
        } else {
            console.log(`[Error] ${err.message}`);
        }
    });

    bot.on('end', () => {
        console.log('❌ Disconnected. Attempting to reconnect in 15 seconds...');
        setTimeout(createBot, 15000);
    });
}

createBot();