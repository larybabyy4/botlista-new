import TelegramBot from 'node-telegram-bot-api';
import schedule from 'node-schedule';
import express from 'express';
import fs from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Setup __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config();

// Initialize Express
const app = express();
app.set('view engine', 'ejs');
app.set('views', join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));

// Initialize JSON storage
const DB_FILE = './database.json';
let db = {
  channels: [],
  users: []
};

// Load database from file
try {
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  }
} catch (error) {
  console.error('Error loading database:', error);
}

// Save database to file
function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (error) {
    console.error('Error saving database:', error);
  }
}

// Initialize bot
const bot = new TelegramBot(process.env.BOT_TOKEN, { 
  polling: true,
  filepath: false
});

// Error handlers
bot.on('polling_error', (error) => {
  console.error('Bot polling error:', error);
});

bot.on('error', (error) => {
  console.error('Bot general error:', error);
});

// Helper functions
function findUser(userId) {
  return db.users.find(u => u.userId === userId.toString());
}

function createUser(userId) {
  const user = {
    userId: userId.toString(),
    channelCount: 0,
    isBanned: false
  };
  db.users.push(user);
  saveDB();
  return user;
}

function findChannel(channelId) {
  return db.channels.find(c => c.channelId === channelId.toString());
}

// Create chunks of array for buttons
function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// Web interface routes
app.get('/', (req, res) => {
  const stats = {
    totalChannels: db.channels.length,
    totalUsers: db.users.length,
    pendingApproval: db.channels.filter(c => !c.isApproved).length,
    categories: {
      '100-1000': db.channels.filter(c => c.category === '100-1000').length,
      '1000-5000': db.channels.filter(c => c.category === '1000-5000').length,
      '5000+': db.channels.filter(c => c.category === '5000+').length
    }
  };
  
  res.render('dashboard', { 
    channels: db.channels,
    users: db.users,
    stats
  });
});

app.post('/approve/:channelId', (req, res) => {
  const channel = findChannel(req.params.channelId);
  if (channel) {
    channel.isApproved = true;
    saveDB();
    bot.sendMessage(channel.channelId, 
      '✅ Canal/grupo aprovado!\n' +
      'As divulgações começarão no próximo ciclo.'
    );
  }
  res.redirect('/');
});

app.post('/disapprove/:channelId', (req, res) => {
  const channel = findChannel(req.params.channelId);
  if (channel) {
    channel.isApproved = false;
    saveDB();
    bot.sendMessage(channel.channelId, 
      '❌ Canal/grupo desaprovado.\n' +
      'Entre em contato com o administrador para mais informações.'
    );
  }
  res.redirect('/');
});

app.post('/ban/:userId', (req, res) => {
  const user = findUser(req.params.userId);
  if (user) {
    user.isBanned = true;
    saveDB();
  }
  res.redirect('/');
});

app.post('/unban/:userId', (req, res) => {
  const user = findUser(req.params.userId);
  if (user) {
    user.isBanned = false;
    saveDB();
  }
  res.redirect('/');
});

// Auto-register channel when bot is added as admin
bot.on('my_chat_member', async (chatMember) => {
  try {
    if ((chatMember.chat.type === 'channel' || chatMember.chat.type === 'supergroup') && 
        chatMember.new_chat_member.status === 'administrator') {
      
      const channelId = chatMember.chat.id;
      const chatInfo = await bot.getChat(channelId);
      const memberCount = await bot.getChatMemberCount(channelId);
      const addedBy = chatMember.from.id;
      let user = findUser(addedBy) || createUser(addedBy);
      
      if (user.isBanned) {
        await bot.sendMessage(channelId, '❌ Usuário banido não pode registrar canais/grupos.');
        return;
      }

      if (user.channelCount >= 3) {
        await bot.sendMessage(channelId, '❌ Limite máximo de 3 canais/grupos atingido.');
        return;
      }

      if (memberCount < 100) {
        await bot.sendMessage(channelId, 
          '❌ Canal/grupo não registrado: mínimo de 100 membros necessário.\n' +
          `Membros atuais: ${memberCount}`
        );
        return;
      }

      // Generate invite link
      let inviteLink;
      try {
        inviteLink = await bot.exportChatInviteLink(channelId);
      } catch (error) {
        console.error('Error generating invite link:', error);
        inviteLink = null;
      }

      let category;
      if (memberCount < 1000) category = '100-1000';
      else if (memberCount < 5000) category = '1000-5000';
      else category = '5000+';

      const channel = {
        channelId: channelId.toString(),
        title: chatInfo.title,
        memberCount,
        category,
        ownerId: addedBy.toString(),
        username: chatInfo.username,
        inviteLink,
        isApproved: false,
        type: chatMember.chat.type
      };

      const existingChannel = findChannel(channelId);
      if (existingChannel) {
        Object.assign(existingChannel, channel);
      } else {
        db.channels.push(channel);
        user.channelCount++;
      }

      saveDB();

      await bot.sendMessage(channelId, 
        '✅ Canal/grupo registrado automaticamente!\n\n' +
        `📌 Título: ${chatInfo.title}\n` +
        `👥 Membros: ${memberCount}\n` +
        `📊 Categoria: ${category}\n` +
        `🔗 Link de convite: ${inviteLink || 'Não disponível'}\n\n` +
        'ℹ️ Aguardando aprovação para início das divulgações.'
      );
    }
  } catch (error) {
    console.error('Error in auto-registration:', error);
    try {
      await bot.sendMessage(chatMember.chat.id, 
        '❌ Erro ao registrar canal/grupo automaticamente.\n' +
        'Por favor, verifique se o bot tem todas as permissões necessárias.'
      );
    } catch (sendError) {
      console.error('Error sending error message:', sendError);
    }
  }
});

// Bot commands
bot.onText(/\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    console.log('Start command received from:', chatId);
    
    await bot.sendMessage(chatId, 
      'Bem-vindo ao Bot de Divulgação! 📢\n\n' +
      'Comandos disponíveis:\n' +
      '/registrar - Registrar um novo canal/grupo\n' +
      '/minhascanais - Ver seus canais/grupos registrados\n' +
      '/listas - Ver listas de divulgação\n' +
      '/ajuda - Ver instruções de uso'
    );
  } catch (error) {
    console.error('Error in /start command:', error);
  }
});

bot.onText(/\/registrar/, async (msg) => {
  try {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    console.log('Register command received from:', userId);
    
    let user = findUser(userId) || createUser(userId);

    if (user.isBanned) {
      return bot.sendMessage(chatId, '❌ Você está banido e não pode registrar canais/grupos.');
    }

    if (user.channelCount >= 3) {
      return bot.sendMessage(chatId, '❌ Você já atingiu o limite máximo de 3 canais/grupos.');
    }

    await bot.sendMessage(chatId, 
      '📝 Para registrar um canal ou grupo:\n\n' +
      '1. Adicione este bot como administrador\n' +
      '2. O registro será feito automaticamente!\n\n' +
      'Requisitos:\n' +
      '• Mínimo de 100 membros\n' +
      '• Canal/grupo deve ser público\n' +
      '• Bot precisa ser administrador'
    );
  } catch (error) {
    console.error('Error in /registrar command:', error);
    await bot.sendMessage(msg.chat.id, '❌ Ocorreu um erro ao processar seu comando. Por favor, tente novamente.');
  }
});

bot.onText(/\/minhascanais/, async (msg) => {
  try {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    console.log('My channels command received from:', userId);

    const userChannels = db.channels.filter(c => c.ownerId === userId.toString());

    if (userChannels.length === 0) {
      return bot.sendMessage(chatId, '📢 Você ainda não tem canais/grupos registrados.');
    }

    const channelList = userChannels.map(channel => 
      `📌 ${channel.title}\n` +
      `👥 ${channel.memberCount} membros\n` +
      `📊 Categoria: ${channel.category}\n` +
      `✅ Aprovado: ${channel.isApproved ? 'Sim' : 'Não'}\n` +
      `📱 Tipo: ${channel.type === 'channel' ? 'Canal' : 'Grupo'}\n` +
      `🔗 Link: ${channel.inviteLink || 'Não disponível'}\n`
    ).join('\n');

    await bot.sendMessage(chatId, 
      '📋 Seus canais/grupos registrados:\n\n' + channelList
    );
  } catch (error) {
    console.error('Error in /minhascanais command:', error);
    await bot.sendMessage(msg.chat.id, '❌ Ocorreu um erro ao listar seus canais/grupos. Por favor, tente novamente.');
  }
});

bot.onText(/\/listas/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    console.log('Lists command received from:', chatId);

    const categories = ['100-1000', '1000-5000', '5000+'];
    let fullMessage = '📢 Listas de Divulgação\n\n';

    for (const category of categories) {
      const channels = db.channels.filter(c => c.category === category && c.isApproved);

      if (channels.length > 0) {
        fullMessage += `📊 Categoria ${category} membros:\n`;
        channels.forEach(channel => {
          fullMessage += `• ${channel.title} (${channel.type === 'channel' ? 'Canal' : 'Grupo'})\n  ${channel.inviteLink || '@' + channel.username}\n`;
        });
        fullMessage += '\n';
      }
    }

    await bot.sendMessage(chatId, fullMessage);
  } catch (error) {
    console.error('Error in /listas command:', error);
    await bot.sendMessage(msg.chat.id, '❌ Ocorreu um erro ao listar os canais/grupos. Por favor, tente novamente.');
  }
});

bot.onText(/\/ajuda/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    console.log('Help command received from:', chatId);

    await bot.sendMessage(chatId,
      '📖 Instruções de Uso\n\n' +
      '1️⃣ Para registrar um canal ou grupo:\n' +
      '• Use /registrar para ver as instruções\n' +
      '• Adicione o bot como admin\n' +
      '• O registro será automático!\n\n' +
      '2️⃣ Requisitos:\n' +
      '• Mínimo 100 membros\n' +
      '• Canal/grupo deve ser público\n' +
      '• Bot precisa ser admin\n\n' +
      '3️⃣ Limites:\n' +
      '• Máximo 3 canais/grupos por usuário\n' +
      '• Divulgação a cada minuto\n\n' +
      '4️⃣ Comandos:\n' +
      '/start - Iniciar bot\n' +
      '/registrar - Novo canal/grupo\n' +
      '/minhascanais - Ver seus canais/grupos\n' +
      '/listas - Ver divulgações\n' +
      '/ajuda - Ver este menu'
    );
  } catch (error) {
    console.error('Error in /ajuda command:', error);
    await bot.sendMessage(msg.chat.id, '❌ Ocorreu um erro ao mostrar a ajuda. Por favor, tente novamente.');
  }
});

// Schedule promotional posts every minute
schedule.scheduleJob('*/10 * * * *', async () => {
  try {
    const categories = ['100-1000', '1000-5000', '5000+'];
    
    for (const category of categories) {
      const channels = db.channels.filter(c => c.category === category && c.isApproved);
      if (channels.length === 0) continue;

      // Create header message
      const headerMessage = `📢 Lista de Canais e Grupos Parceiros\n` +
                          `📊 Categoria: ${category} membros\n` +
                          `👥 Total: ${channels.length} participantes\n\n` +
                          `Clique nos botões abaixo para entrar:`;

      // Create inline keyboard with up to 20 buttons
      const inlineKeyboard = channels.slice(0, 20).map(channel => [{
        text: `${channel.title} (${channel.type === 'channel' ? 'Canal' : 'Grupo'})`,
        url: channel.inviteLink || `https://t.me/${channel.username}`
      }]);

      // Footer message
      const footerMessage = '\n\n💡 Divulgação automática a cada minuto\n' +
                          '🤖 Para participar, adicione nosso bot como admin!';

      for (const channel of channels) {
        try {
          const sent = await bot.sendMessage(channel.channelId, headerMessage, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: {
              inline_keyboard: inlineKeyboard
            }
          });
          
          // Pin message for 30 seconds if it's a channel
          if (channel.type === 'channel') {
            await bot.pinChatMessage(channel.channelId, sent.message_id);
            setTimeout(() => {
              bot.unpinChatMessage(channel.channelId);
            }, 30000);
          }

          // Send footer as separate message
          await bot.sendMessage(channel.channelId, footerMessage);
        } catch (error) {
          console.error(`Error posting to ${channel.type} ${channel.title}:`, error);
        }
      }
    }
  } catch (error) {
    console.error('Error in promotional post schedule:', error);
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Interface de gerenciamento rodando em http://localhost:${PORT}`);
  console.log('🤖 Bot iniciado com sucesso!');
});
