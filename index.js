require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { google } = require('googleapis');
const express = require('express');

// Express server for health checks
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({ 
    status: 'running', 
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({
    bot_status: client.isReady() ? 'ready' : 'not_ready',
    cards_loaded: tarotBot.cards.length,
    spreads_loaded: Object.keys(tarotBot.spreads).length
  });
});

const server = app.listen(PORT, () => {
  console.log(`Health check server running on port ${PORT}`);
});

// Discord client setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
  ],
  partials: [
    Partials.Channel, // DMチャンネル用
    Partials.Message, // DMメッセージ用
  ],
});

// Google Sheets setup
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// Tarot card class
class TarotBot {
  constructor() {
    this.cards = [];
    this.spreads = {};
  }

  // Google Sheetsからカードデータを取得（意味も含む）
  async loadCards() {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Cards!A:D', // D列（意味）も取得
      });
      
      const rows = response.data.values;
      if (rows && rows.length > 1) {
        this.cards = rows.slice(1).map(row => ({
          id: parseInt(row[0]),
          name: row[1],
          type: row[2],
          meaning: row[3] || 'カードの意味' // D列の値、なければデフォルト
        }));
        console.log(`Loaded ${this.cards.length} cards with meanings`);
        return true;
      }
      return false;
    } catch (error) {
      console.error('Error loading cards:', error);
      return false;
    }
  }

  // スプレッドデータを取得
  async loadSpreads() {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Spreads!A:K',
      });
      
      const rows = response.data.values;
      if (rows && rows.length > 1) {
        rows.slice(1).forEach(row => {
          const spreadName = row[0];
          const positions = row.slice(1).filter(pos => pos && pos.trim() !== '');
          this.spreads[spreadName] = positions;
        });
        console.log(`Loaded spreads:`, Object.keys(this.spreads));
        return true;
      }
      return false;
    } catch (error) {
      console.error('Error loading spreads:', error);
      return false;
    }
  }

  // ランダムにカードを選択（重複なし）
  selectRandomCards(count) {
    const selectedCards = [];
    const availableCards = [...this.cards];
    
    for (let i = 0; i < count && availableCards.length > 0; i++) {
      const randomIndex = Math.floor(Math.random() * availableCards.length);
      const card = availableCards.splice(randomIndex, 1)[0];
      const isReversed = Math.random() < 0.5;
      
      selectedCards.push({
        ...card,
        position: isReversed ? '逆位置' : '正位置'
      });
    }
    
    return selectedCards;
  }

  // 占いを実行
  async performReading(spreadName, question, userId = 'unknown') {
    if (!this.spreads[spreadName]) {
      return null;
    }

    const positions = this.spreads[spreadName];
    const selectedCards = this.selectRandomCards(positions.length);
    
    const reading = {
      spread: spreadName,
      question: question,
      userId: userId,
      results: positions.map((position, index) => ({
        position: position,
        card: selectedCards[index]
      })),
      timestamp: new Date().toISOString()
    };

    // 結果をGoogle Sheetsに保存
    await this.saveReading(reading);
    
    return reading;
  }

  // 占い結果をGoogle Sheetsに保存（ユーザーID追加）
  async saveReading(reading) {
    try {
      const resultText = reading.results
        .map(r => `${r.position}:${r.card.name}(${r.card.position})`)
        .join(', ');
      
      const row = [
        reading.timestamp,
        reading.userId,
        reading.question,
        reading.spread,
        resultText
      ];

      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Readings!A:E', // E列まで拡張
        valueInputOption: 'RAW',
        resource: {
          values: [row]
        }
      });
    } catch (error) {
      console.error('Error saving reading:', error);
    }
  }

  // 占い履歴を取得
  async getReadingHistory(userId, limit = 5) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Readings!A:E',
      });
      
      const rows = response.data.values;
      if (!rows || rows.length <= 1) {
        return [];
      }

      // ヘッダーを除き、ユーザーIDでフィルター、日時で降順ソート
      const userReadings = rows.slice(1)
        .filter(row => row[1] === userId)
        .sort((a, b) => new Date(b[0]) - new Date(a[0]))
        .slice(0, limit);

      return userReadings.map(row => ({
        timestamp: row[0],
        userId: row[1],
        question: row[2],
        spread: row[3],
        result: row[4]
      }));
    } catch (error) {
      console.error('Error getting reading history:', error);
      return [];
    }
  }

  // 結果をDiscord用にフォーマット（意味も含む）
  formatReading(reading) {
    const spreadNames = {
      'celt': 'ケルト十字スプレッド',
      'three': 'スリーカード',
      'one': 'ワンカード',
      'kantan': 'かんたんスプレッド',
      'nitaku': '二択スプレッド'
    };

    let message = `🔮 **${spreadNames[reading.spread] || reading.spread}** - ${reading.question}\n\n`;
    
    // 二択スプレッドの場合は特別なフォーマット
    if (reading.spread === 'nitaku') {
      message += `**🌟 現在の状況**\n`;
      message += `${reading.results[0].card.name}（${reading.results[0].card.position}）\n`;
      message += `　└ *${reading.results[0].card.meaning}*\n\n`;
      
      message += `**🅰️ 選択肢A**\n`;
      message += `**現状**: ${reading.results[1].card.name}（${reading.results[1].card.position}）\n`;
      message += `　└ *${reading.results[1].card.meaning}*\n`;
      message += `**近未来**: ${reading.results[2].card.name}（${reading.results[2].card.position}）\n`;
      message += `　└ *${reading.results[2].card.meaning}*\n`;
      message += `**最終結果**: ${reading.results[3].card.name}（${reading.results[3].card.position}）\n`;
      message += `　└ *${reading.results[3].card.meaning}*\n\n`;
      
      message += `**🅱️ 選択肢B**\n`;
      message += `**現状**: ${reading.results[4].card.name}（${reading.results[4].card.position}）\n`;
      message += `　└ *${reading.results[4].card.meaning}*\n`;
      message += `**近未来**: ${reading.results[5].card.name}（${reading.results[5].card.position}）\n`;
      message += `　└ *${reading.results[5].card.meaning}*\n`;
      message += `**最終結果**: ${reading.results[6].card.name}（${reading.results[6].card.position}）\n`;
      message += `　└ *${reading.results[6].card.meaning}*\n\n`;
      
      message += `**💡 アドバイス**\n`;
      message += `${reading.results[7].card.name}（${reading.results[7].card.position}）\n`;
      message += `　└ *${reading.results[7].card.meaning}*\n\n`;
    } else {
      // 従来のスプレッドのフォーマット
      reading.results.forEach(result => {
        message += `**${result.position}**: ${result.card.name}（${result.card.position}）\n`;
        message += `　└ *${result.card.meaning}*\n\n`;
      });
    }
    
    message += `質問: ${reading.question}`;
    
    return message;
  }

  // 履歴をDiscord用にフォーマット
  formatHistory(history) {
    if (history.length === 0) {
      return '📋 **占い履歴**\n\n履歴がありません。';
    }

    let message = `📋 **占い履歴**（最新${history.length}件）\n\n`;
    
    history.forEach((record, index) => {
      const date = new Date(record.timestamp).toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
      
      const spreadNames = {
        'celt': 'ケルト十字',
        'three': 'スリーカード',
        'one': 'ワンカード',
        'kantan': 'かんたん'
      };
      
      message += `**${index + 1}.** ${date}\n`;
      message += `　${spreadNames[record.spread] || record.spread} - ${record.question}\n\n`;
    });

    return message;
  }
}

// TarotBotインスタンス作成
const tarotBot = new TarotBot();

// Botの準備完了
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  console.log(`Bot ID: ${client.user.id}`);
  console.log(`Bot can be DMed: ${client.user.bot}`);
  
  // データ読み込みをリトライ機能付きで実行
  let retries = 3;
  while (retries > 0) {
    const cardsLoaded = await tarotBot.loadCards();
    const spreadsLoaded = await tarotBot.loadSpreads();
    
    if (cardsLoaded && spreadsLoaded) {
      console.log('Enhanced Tarot Bot is ready!');
      console.log('🔹 Ready to receive DMs and server messages');
      break;
    }
    
    retries--;
    console.log(`Retrying data load... (${retries} attempts left)`);
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  
  if (retries === 0) {
    console.error('Failed to load data after 3 attempts');
  }
});

// エラーハンドリング
client.on('error', (error) => {
  console.error('Discord client error:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

// メッセージ処理
client.on('messageCreate', async (message) => {
  // Bot自身のメッセージは無視
  if (message.author.bot) return;
  
  // !divineで始まらないメッセージは無視
  if (!message.content.startsWith('!divine')) return;

  const args = message.content.split(' ');
  const command = args[1];
  const userId = message.author.id;

  try {
    switch (command) {
      case 'help':
        const helpMessage = `
🔮 **TarotBot コマンド一覧**

**占いコマンド:**
\`!divine one [質問]\` - ワンカード占い
\`!divine three [質問]\` - スリーカード占い（過去・現在・未来）
\`!divine celt [質問]\` - ケルト十字占い（10枚）
\`!divine kantan [質問]\` - かんたんスプレッド（原因・結果・対策）
\`!divine nitaku [質問]\` - 二択スプレッド（AとBの選択肢を比較）

**その他:**
\`!divine help\` - このヘルプを表示
\`!divine spreads\` - 利用可能なスプレッド一覧
\`!divine history\` - あなたの占い履歴を表示
\`!divine status\` - ボットの状態を表示

**使用例:**
\`!divine nitaku 転職するべきか今の会社に残るべきか\`
\`!divine kantan 仕事がうまくいかない\`
\`!divine celt 恋愛運について\`
\`!divine three 今日の運勢は？\`

💌 **このbotはDMでも利用できます！**
        `;
        await message.reply(helpMessage);
        break;

      case 'spreads':
        const spreadsList = Object.keys(tarotBot.spreads)
          .map(spread => {
            const names = {
              'one': 'ワンカード',
              'three': 'スリーカード', 
              'celt': 'ケルト十字',
              'kantan': 'かんたんスプレッド',
              'nitaku': '二択スプレッド'
            };
            return `• **${names[spread] || spread}** (${spread}): ${tarotBot.spreads[spread].length}枚`;
          })
          .join('\n');
        await message.reply(`🔮 **利用可能なスプレッド:**\n${spreadsList}`);
        break;

      case 'status':
        const uptime = Math.floor(process.uptime() / 60);
        await message.reply(
          `🤖 **ボット状態:**\n` +
          `稼働時間: ${uptime}分\n` +
          `カード数: ${tarotBot.cards.length}/78\n` +
          `スプレッド数: ${Object.keys(tarotBot.spreads).length}\n` +
          `対応: サーバー・DM両方\n` +
          `新機能: カード意味表示、履歴表示、かんたんスプレッド、二択スプレッド`
        );
        break;

      case 'history':
        const history = await tarotBot.getReadingHistory(userId, 5);
        const formattedHistory = tarotBot.formatHistory(history);
        await message.reply(formattedHistory);
        break;

      case 'one':
      case 'three':
      case 'celt':
      case 'kantan':
      case 'nitaku': // 新しいスプレッド追加
        const question = args.slice(2).join(' ') || '質問なし';
        
        if (tarotBot.cards.length === 0) {
          await message.reply('❌ カードデータの読み込み中です。少し待ってから再試行してください。');
          return;
        }

        const reading = await tarotBot.performReading(command, question, userId);
        
        if (!reading) {
          await message.reply('❌ 指定されたスプレッドが見つかりません。');
          return;
        }

        const formattedResult = tarotBot.formatReading(reading);
        
        // メッセージが長すぎる場合は分割
        if (formattedResult.length > 2000) {
          const lines = formattedResult.split('\n');
          let currentMessage = '';
          
          for (const line of lines) {
            if (currentMessage.length + line.length > 1900) {
              await message.reply(currentMessage);
              currentMessage = line + '\n';
            } else {
              currentMessage += line + '\n';
            }
          }
          
          if (currentMessage.trim()) {
            await message.reply(currentMessage);
          }
        } else {
          await message.reply(formattedResult);
        }
        break;

      default:
        await message.reply(
          '❌ 不明なコマンドです。`!divine help`でヘルプを確認してください。\n' +
          '新しいスプレッド `kantan` も利用できます！'
        );
    }
  } catch (error) {
    console.error('Error processing command:', error);
    await message.reply('❌ エラーが発生しました。しばらく待ってから再試行してください。');
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  server.close(() => {
    client.destroy();
    process.exit(0);
  });
});

// Botを起動
client.login(process.env.DISCORD_TOKEN);
