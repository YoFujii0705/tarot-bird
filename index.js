require('dotenv').config();
const { Client, GatewayIntentBits, Partials, AttachmentBuilder } = require('discord.js');
const { google } = require('googleapis');
const express = require('express');
const { createCanvas, loadImage } = require('canvas');

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
    Partials.Channel,
    Partials.Message,
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
    this.cardImages = new Map();
  }

  // Google Sheetsからカードデータを取得
  async loadCards() {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Cards!A:E', // E列に画像IDを追加
      });
      
      const rows = response.data.values;
      if (rows && rows.length > 1) {
        this.cards = rows.slice(1).map(row => ({
          id: parseInt(row[0]),
          name: row[1],
          type: row[2],
          meaning: row[3] || 'カードの意味',
          imageId: row[4] || null // Google DriveのファイルID
        }));
        console.log(`Loaded ${this.cards.length} cards with meanings and images`);
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

  // Google DriveのファイルIDから公開URLを生成
  getGoogleDriveImageUrl(fileId) {
    return `https://drive.google.com/uc?id=${fileId}&export=download`;
  }

  // プレースホルダーカード画像を作成
  createPlaceholderCard(card) {
    const canvas = createCanvas(150, 250);
    const ctx = canvas.getContext('2d');

    // 背景
    ctx.fillStyle = '#2C3E50';
    ctx.fillRect(0, 0, 150, 250);

    // 枠線
    ctx.strokeStyle = '#ECF0F1';
    ctx.lineWidth = 2;
    ctx.strokeRect(5, 5, 140, 240);

    // カード名（日本語フォント使用）
    ctx.fillStyle = '#ECF0F1';
    ctx.font = 'bold 12px Japanese, Arial, sans-serif';
    ctx.textAlign = 'center';
    
    // カード名を描画
    ctx.fillText(card.name, 75, 125);
    
    // タイプを表示
    ctx.font = '10px Japanese, Arial, sans-serif';
    ctx.fillText(card.type, 75, 230);

    return canvas;
  }

  // カード画像を読み込み（キャッシュ付き）
  async loadCardImage(card) {
    if (this.cardImages.has(card.id)) {
      return this.cardImages.get(card.id);
    }

    try {
      let image;
      
      if (card.imageId && card.imageId.trim() !== '') {
        console.log(`Loading image for card ${card.name} with ID: ${card.imageId}`);
        
        const imageUrl = this.getGoogleDriveImageUrl(card.imageId);
        console.log(`Google Drive URL: ${imageUrl}`);
        
        // タイムアウト付きで画像読み込み
        image = await Promise.race([
          loadImage(imageUrl),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Image load timeout')), 8000)
          )
        ]);
        
        console.log(`Successfully loaded image for ${card.name}: ${image.width}x${image.height}`);
      } else {
        console.log(`No image ID for card ${card.name}, creating placeholder`);
        image = this.createPlaceholderCard(card);
      }

      this.cardImages.set(card.id, image);
      return image;
    } catch (error) {
      console.error(`Error loading image for card ${card.name}:`, error.message);
      const placeholder = this.createPlaceholderCard(card);
      this.cardImages.set(card.id, placeholder);
      return placeholder;
    }
  }

  // スプレッド画像を生成（5列×2行のシンプル配置）
  async generateSpreadImage(reading) {
    console.log(`=== NEW CANVAS TEST: Generating spread image for: ${reading.spread} ===`);
    
    try {
      const cardCount = reading.results.length;
      console.log(`Card count: ${cardCount}`);
      
      // 固定値で設定
      const CARD_WIDTH = 120;
      const CARD_HEIGHT = 200;
      const CARD_SPACING_X = 140;
      const CARD_SPACING_Y = 280; // カード間の縦間隔
      const MARGIN_X = 70;
      const TOP_MARGIN = 300; // 上部マージン（タイトルスペース）
      const BOTTOM_MARGIN = 60; // 下部マージン（ラベルスペース）
      
      // 配置計算（最大5列）
      const maxCols = Math.min(cardCount, 5);
      const rows = Math.ceil(cardCount / 5);
      
      const canvasWidth = MARGIN_X * 2 + (maxCols * CARD_SPACING_X);
      
      // 高さを実際に必要な分だけに調整
      const cardsAreaHeight = (rows - 1) * CARD_SPACING_Y + CARD_HEIGHT; // カード部分の実際の高さ
      const canvasHeight = TOP_MARGIN + cardsAreaHeight + BOTTOM_MARGIN; // 必要最小限の高さ
      
      console.log(`Calculated dimensions: ${canvasWidth} x ${canvasHeight}`);
      console.log(`Layout: ${maxCols} cols x ${rows} rows`);
      
      // Canvas作成
      const canvas = createCanvas(canvasWidth, canvasHeight);
      const ctx = canvas.getContext('2d');

      // 背景
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);

      // タイトル（日本語フォント使用）
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 24px Japanese, Arial, sans-serif';
      ctx.textAlign = 'center';
      const spreadNames = {
        'celt': 'ケルト十字スプレッド',
        'three': 'スリーカード',
        'one': 'ワンカード',
        'kantan': 'かんたんスプレッド',
        'nitaku': '二択スプレッド',
        'horse': 'ホースシュースプレッド'
      };
      ctx.fillText(spreadNames[reading.spread] || reading.spread, canvasWidth / 2, 40);

      // 質問（日本語フォント使用）
      ctx.font = '16px Japanese, Arial, sans-serif';
      ctx.fillText(`質問: ${reading.question}`, canvasWidth / 2, 70);
      
      // 区切り線を追加
      ctx.strokeStyle = '#666666';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(50, 85);
      ctx.lineTo(canvasWidth - 50, 85);
      ctx.stroke();
      // カード配置
      for (let i = 0; i < cardCount; i++) {
        const result = reading.results[i];
        const card = result.card;
        const isReversed = card.position === '逆位置';

        // 位置計算（完全中央寄せ）
        const col = i % 5;
        const row = Math.floor(i / 5);
        
        // 各行のカード数を計算
        const cardsInThisRow = Math.min(cardCount - (row * 5), 5);
        
        // この行のカードを中央寄せで配置
        const rowWidth = (cardsInThisRow - 1) * CARD_SPACING_X;
        const rowStartX = (canvasWidth - rowWidth) / 2;
        
        const x = rowStartX + (col * CARD_SPACING_X);
        const y = TOP_MARGIN + (row * CARD_SPACING_Y);

        console.log(`Card ${i}: ${card.name} at (${x}, ${y}), reversed: ${isReversed}`);

        try {
          // 画像読み込み
          const cardImage = await this.loadCardImage(card);

          // Canvas操作
          ctx.save();
          ctx.translate(x, y);

          // 逆位置の場合は180度回転
          if (isReversed) {
            ctx.rotate(Math.PI);
          }

          // カード描画
          ctx.drawImage(cardImage, -CARD_WIDTH/2, -CARD_HEIGHT/2, CARD_WIDTH, CARD_HEIGHT);
          ctx.restore();

          // ラベル描画（常に正立）（日本語フォント使用）
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 12px Japanese, Arial, sans-serif';
          ctx.textAlign = 'center';
          
          const labelY = y + CARD_HEIGHT/2 + 20;
          ctx.fillText(result.position, x, labelY);
          
          // カード名と正逆位置を組み合わせて表示（長い場合は2行に分割）
          ctx.font = '10px Japanese, Arial, sans-serif';
          ctx.fillStyle = isReversed ? '#ff6b6b' : '#4ecdc4';
          const positionText = card.position === '逆位置' ? '逆' : '正';
          const cardInfo = `${card.name} ${positionText}`;
          
          // カード名が長い場合は2行に分割
          if (cardInfo.length > 12) {
            ctx.fillText(card.name, x, labelY + 15);
            ctx.fillText(positionText, x, labelY + 27);
          } else {
            ctx.fillText(cardInfo, x, labelY + 15);
          }

        } catch (drawError) {
          console.error(`Error drawing card ${card.name}:`, drawError);
          
          // エラー時は四角形で代替
          ctx.fillStyle = '#666666';
          ctx.fillRect(x - CARD_WIDTH/2, y - CARD_HEIGHT/2, CARD_WIDTH, CARD_HEIGHT);
          
          ctx.fillStyle = '#ffffff';
          ctx.font = '12px Japanese, Arial, sans-serif';
          ctx.textAlign = 'center';
          
          // エラー時もカード名と正逆位置を組み合わせて表示
          const positionText = card.position === '逆位置' ? '逆' : '正';
          const cardInfo = `${card.name} ${positionText}`;
          ctx.fillText(cardInfo, x, y);
        }
      }

      console.log(`=== Canvas generation completed successfully ===`);
      return canvas.toBuffer('image/png');
      
    } catch (error) {
      console.error('Canvas generation failed:', error);
      return null;
    }
  }

  // ランダムにカードを選択
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

    await this.saveReading(reading);
    return reading;
  }

  // 占い結果をGoogle Sheetsに保存
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
        range: 'Readings!A:E',
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

  // 結果をDiscord用にフォーマット
  formatReading(reading) {
    const spreadNames = {
      'celt': 'ケルト十字スプレッド',
      'three': 'スリーカード',
      'one': 'ワンカード',
      'kantan': 'かんたんスプレッド',
      'nitaku': '二択スプレッド',
      'horse': 'ホースシュースプレッド'
    };

    let message = `🔮 **${spreadNames[reading.spread] || reading.spread}** - ${reading.question}\n\n`;
    
    if (reading.spread === 'horse') {
      message += `**📅 過去**\n${reading.results[0].card.name}（${reading.results[0].card.position}）\n　└ *${reading.results[0].card.meaning}*\n\n`;
      message += `**🕐 現在**\n${reading.results[1].card.name}（${reading.results[1].card.position}）\n　└ *${reading.results[1].card.meaning}*\n\n`;
      message += `**🔮 近未来**\n${reading.results[2].card.name}（${reading.results[2].card.position}）\n　└ *${reading.results[2].card.meaning}*\n\n`;
      message += `**💡 アドバイス**\n${reading.results[3].card.name}（${reading.results[3].card.position}）\n　└ *${reading.results[3].card.meaning}*\n\n`;
      message += `**👥 周囲（相手）の状況**\n${reading.results[4].card.name}（${reading.results[4].card.position}）\n　└ *${reading.results[4].card.meaning}*\n\n`;
      message += `**⚠️ 障害**\n${reading.results[5].card.name}（${reading.results[5].card.position}）\n　└ *${reading.results[5].card.meaning}*\n\n`;
      message += `**🎯 最終予想**\n${reading.results[6].card.name}（${reading.results[6].card.position}）\n　└ *${reading.results[6].card.meaning}*\n\n`;
    } else {
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
        'kantan': 'かんたん',
        'nitaku': '二択',
        'horse': 'ホースシュー'
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
  console.log(`=== NEW BOT VERSION STARTED ===`);
  console.log(`Logged in as ${client.user.tag}!`);
  console.log(`Bot ID: ${client.user.id}`);
  
  let retries = 3;
  while (retries > 0) {
    const cardsLoaded = await tarotBot.loadCards();
    const spreadsLoaded = await tarotBot.loadSpreads();
    
    if (cardsLoaded && spreadsLoaded) {
      console.log('=== NEW Enhanced Tarot Bot with Dynamic Images is ready! ===');
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
  if (message.author.bot) return;
  if (!message.content.startsWith('!divine')) return;

  const args = message.content.split(' ');
  const command = args[1];
  const userId = message.author.id;

  console.log(`=== NEW BOT: Received command: ${command} ===`);

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
\`!divine horse [質問]\` - ホースシュースプレッド（7枚、全体的な流れと状況）

**その他:**
\`!divine help\` - このヘルプを表示
\`!divine spreads\` - 利用可能なスプレッド一覧
\`!divine history\` - あなたの占い履歴を表示
\`!divine status\` - ボットの状態を表示
\`!divine test\` - Canvas動作テスト

**新機能:**
✨ カード画像の動的生成
✨ 逆位置カードの180度回転表示
✨ スプレッド配置の視覚化

💌 **このbotはDMでも利用できます！**
        `;
        await message.reply(helpMessage);
        break;

      case 'test':
        console.log('=== CANVAS TEST STARTED ===');
        try {
          const testCanvas = createCanvas(300, 200);
          const testCtx = testCanvas.getContext('2d');
          
          testCtx.fillStyle = '#ff0000';
          testCtx.fillRect(0, 0, 300, 200);
          
          testCtx.fillStyle = '#ffffff';
          testCtx.font = '20px Arial';
          testCtx.textAlign = 'center';
          testCtx.fillText('Canvas Test OK!', 150, 100);
          
          const testBuffer = testCanvas.toBuffer('image/png');
          const testAttachment = new AttachmentBuilder(testBuffer, { name: 'canvas_test.png' });
          
          await message.reply({ content: '✅ Canvas test successful!', files: [testAttachment] });
          console.log('=== CANVAS TEST COMPLETED SUCCESSFULLY ===');
        } catch (testError) {
          console.error('Canvas test failed:', testError);
          await message.reply(`❌ Canvas test failed: ${testError.message}`);
        }
        break;

      case 'spreads':
        const spreadsList = Object.keys(tarotBot.spreads)
          .map(spread => {
            const names = {
              'one': 'ワンカード',
              'three': 'スリーカード', 
              'celt': 'ケルト十字',
              'kantan': 'かんたんスプレッド',
              'nitaku': '二択スプレッド',
              'horse': 'ホースシュースプレッド'
            };
            return `• **${names[spread] || spread}** (${spread}): ${tarotBot.spreads[spread].length}枚`;
          })
          .join('\n');
        await message.reply(`🔮 **利用可能なスプレッド:**\n${spreadsList}\n\n✨ **新機能**: 各スプレッドで視覚的なカード配置画像が生成されます！`);
        break;

      case 'status':
        const uptime = Math.floor(process.uptime() / 60);
        await message.reply(
          `🤖 **ボット状態 (NEW VERSION):**\n` +
          `稼働時間: ${uptime}分\n` +
          `カード数: ${tarotBot.cards.length}/78\n` +
          `スプレッド数: ${Object.keys(tarotBot.spreads).length}\n` +
          `対応: サーバー・DM両方\n` +
          `新機能: 動的画像生成、逆位置回転表示、視覚的スプレッド配置`
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
      case 'nitaku':
      case 'horse':
        const question = args.slice(2).join(' ') || '質問なし';
        
        if (tarotBot.cards.length === 0) {
          await message.reply('❌ カードデータの読み込み中です。少し待ってから再試行してください。');
          return;
        }

        console.log(`=== NEW BOT: Performing reading for ${command} ===`);
        const reading = await tarotBot.performReading(command, question, userId);
        
        if (!reading) {
          await message.reply('❌ 指定されたスプレッドが見つかりません。');
          return;
        }

        // テキスト結果を準備
        const formattedResult = tarotBot.formatReading(reading);
        
        // 画像を生成
        console.log(`=== NEW BOT: Attempting to generate spread image ===`);
        const imageBuffer = await tarotBot.generateSpreadImage(reading);
        
        if (imageBuffer) {
          console.log(`=== NEW BOT: Image generated successfully, sending... ===`);
          const attachment = new AttachmentBuilder(imageBuffer, { name: `${command}_spread.png` });
          
          if (formattedResult.length > 2000) {
            const lines = formattedResult.split('\n');
            let currentMessage = '';
            let isFirstMessage = true;
            
            for (const line of lines) {
              if (currentMessage.length + line.length > 1900) {
                if (isFirstMessage) {
                  await message.reply({ content: currentMessage, files: [attachment] });
                  isFirstMessage = false;
                } else {
                  await message.channel.send(currentMessage);
                }
                currentMessage = line + '\n';
              } else {
                currentMessage += line + '\n';
              }
            }
            
            if (currentMessage.trim()) {
              await message.channel.send(currentMessage);
            }
          } else {
            await message.reply({ content: formattedResult, files: [attachment] });
          }
        } else {
          console.log(`=== NEW BOT: Image generation failed, sending text only ===`);
          await message.reply(formattedResult + '\n\n⚠️ 画像の生成に失敗しました。テキストのみの表示です。');
        }
        break;

      default:
        await message.reply(
          '❌ 不明なコマンドです。`!divine help`でヘルプを確認してください。\n' +
          '新機能: 画像付きスプレッド表示も利用できます！'
        );
    }
  } catch (error) {
    console.error('=== NEW BOT: Error processing command ===', error);
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

client.login(process.env.DISCORD_TOKEN);
