// Example Pathy bot: echoes whatever it receives, end-to-end encrypted.
//
//   1. Create a bot in the Pathy web UI (🤖 → Create a bot) and copy the token.
//   2. PATHY_BOT_TOKEN=<token> PATHY_BASE_URL=http://localhost:8080 node bots/echo-bot/bot.js
//   3. DM the bot or add it to a group/channel.
import { PathyBot } from '../sdk/index.js';

const bot = new PathyBot({
  stateFile: process.env.PATHY_BOT_STATE || './echo-bot-state.json',
});

bot.on('ready', (me) => console.log(`@${me.username} is up (${me.ref}) — E2E keys published`));
bot.on('joined', (conv) => console.log(`joined ${conv?.type} "${conv?.name ?? conv?.id}"`));
bot.on('error', (err) => console.error('bot error:', err.message));

bot.on('message', async (ctx) => {
  console.log(`[${ctx.conv.type} ${ctx.conv.id}] ${ctx.senderRef}${ctx.verified ? '' : ' (unverified!)'}: ${ctx.text}`);
  if (ctx.text === '/start') {
    return ctx.reply('👋 hi! I am the Pathy echo bot. Everything we exchange is end-to-end encrypted with post-quantum crypto. Say something!');
  }
  await ctx.reply(`echo: ${ctx.text}`);
});

bot.start().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});

process.on('SIGINT', () => { bot.stop(); process.exit(0); });
process.on('SIGTERM', () => { bot.stop(); process.exit(0); });
