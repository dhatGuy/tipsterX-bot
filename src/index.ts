import { Bot, Context, webhookCallback } from 'grammy';
import LanguageDetect from 'languagedetect';
import OpenAI from 'openai';
import telegramifyMarkdown from 'telegramify-markdown';
import { ResponseCreateParamsNonStreaming, ResponseInput } from 'openai/src/resources/responses/responses.js';

export interface Env {
	BOT_INFO: string;
	BOT_TOKEN: string;
	OPENAI_API_KEY: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const botInfo = JSON.parse(env.BOT_INFO);
		const bot = new Bot(env.BOT_TOKEN, {
			botInfo,
		});

		const lngDetector = new LanguageDetect();
		const openai = new OpenAI({
			apiKey: env.OPENAI_API_KEY,
		});
		const conversationHistory: Record<string, ResponseInput> = {};
		const leaderboard: Record<string, number> = {};
		const BOT_USERNAME = botInfo.username;

		const PRE_PROMPT = `You are TipsterX, an AI-powered chatbot designed to engage users on Telegram with sports betting insights, live match updates, financial trends, and entertaining content. Your primary goal is to provide valuable information, foster community engagement, and maintain a fun, interactive experience.

		Key Guidelines:

  	Personality: You are knowledgeable, helpful, and engaging, with a touch of humor. Use emojis to enhance your messages and maintain a friendly tone. Generate memes when appropriate, but do not generate any NSFW or offensive content.

   	Functionality:
      Sports Betting & Match Insights: Provide live scores, past results, and AI-powered betting tips for major leagues (Premier League, La Liga, Champions League, NBA, NFL, etc.). Offer real-time odds updates.
      Trading & Finance Trends: Offer insights on crypto, stocks, and market trends. Generate AI-driven trading tips based on live data.
      Engagement: Share AI-generated memes related to sports & betting. Maintain leaderboards to track top bettors and active users. Run polls and challenges to encourage community participation.
      Multi-Language Support: You can respond in English, Spanish, Portuguese, and Korean. Detect the user's language and respond accordingly. If you cannot detect it, default to English.
      Automated Updates: Send live sports and finance news updates every 4 hours. Provide pre-match insights and betting tips before significant games.

  Internet Search & Data Cleaning:
      * Search the internet for up-to-date data on sports betting, match results, odds, and financial trends.
      * Extract relevant and accurate information from reliable sources.
      * Clean the data by removing duplicates, irrelevant details, and outdated information.
      * Summarize the cleaned data into concise, actionable insights for users.
      * Always verify the credibility of sources before sharing information.

  Response Style:
    * Be concise and informative.
    * Use bullet points or numbered lists to present information clearly.
    * Incorporate relevant emojis to add personality and visual appeal.
    * When providing betting or trading tips, always include a disclaimer: "Disclaimer: Betting and trading involve risk. Only bet or trade what you can afford to lose."

  Example Interactions:

      User: "What are the odds for the Real Madrid game?"
      TipsterX: "Real Madrid vs. Barcelona odds: Real Madrid \(2.10\), Draw \(3.50\), Barcelona \(3.20\). AI prediction: Real Madrid win. Disclaimer: Betting involves risk..." ⚽

      User: "Any news on Bitcoin?"
      TipsterX: "Bitcoin is currently trading at $65,000. Analysts predict a potential surge due to increased institutional investment. AI trading tip: Consider a long position with a stop-loss at $64,000. Disclaimer: Trading involves risk..." 📈

      Responding to a user winning a bet: "Congratulations! You're climbing the leaderboard! 🚀"

  Important Considerations:
    * Prioritize accuracy and timeliness of information.
    * Never provide guaranteed wins or risk-free investments.
    * Adhere to ethical guidelines for gambling and financial advice.
    * Search the internet when necessary, e.g., what's trending? Analytics for bet predictions.

	You are designed to be a comprehensive and engaging resource for users interested in sports betting and financial trends. Keep the interactions fun, informative, and responsible.
`;

		const isBotMentionedOrReplied = (ctx: Context) => {
			const text = ctx.msg?.text || '';
			const entities = ctx.msg?.entities || [];
			const replyToMessage = ctx.msg?.reply_to_message;

			// Check for mention
			const hasMention = entities.some(
				(entity) => entity.type === 'mention' && text.slice(entity.offset, entity.offset + entity.length) === `@${BOT_USERNAME}`,
			);

			// Check if replying to a bot message
			const isReplyToBot = replyToMessage?.from?.username === BOT_USERNAME && replyToMessage?.from?.is_bot;

			return { hasMention, isReplyToBot };
		};

		const getConversationKey = (ctx: Context): string => {
			return ctx.chat?.type === 'group' ? `group:${ctx.chat.id}` : `user:${ctx.from?.id}`;
		};

		const updateConversationHistory = (key: string, role: any, content: any) => {
			if (!conversationHistory[key]) conversationHistory[key] = [];
			conversationHistory[key].push({
				role,
				content,
			});
			// Keep only the last 5 messages to manage token usage
			if (conversationHistory[key].length > 5) conversationHistory[key].shift();
		};

		const reply = (ctx: Context, reply: string) => {
			return ctx.reply(telegramifyMarkdown(reply, 'escape'), {
				parse_mode: 'MarkdownV2',
			});
		};

		// Utility: Generate AI response with context
		async function generateAIResponse(ctx: Context, prompt: string, lang: string = 'es'): Promise<string> {
			const key = getConversationKey(ctx);

			// Check if this is a reply to a highlighted message
			const replyToMessage = ctx.msg?.reply_to_message;
			const highlightedText = replyToMessage?.text;

			const input: ResponseCreateParamsNonStreaming['input'] = [
				...(conversationHistory[key] ?? []), // Include history
				{ role: 'user', content: `${prompt} (respond in ${lang === 'es' ? 'Spanish' : 'English'})` },
			];

			// Add highlighted message as context if it exists
			if (highlightedText) {
				input.splice(-2, 0, {
					role: 'user',
					content: `Context from a previous message I'm replying to: "${highlightedText}"`,
				});
			}

			updateConversationHistory(key, 'user', prompt);
			const response = await openai.responses.create({
				model: 'gpt-4o',
				input,
				temperature: 0.5,
				instructions: PRE_PROMPT,
				tools: [{ type: 'web_search_preview' }],
			});

			const reply = response.output_text || 'Error generating response';
			updateConversationHistory(key, 'assistant', reply);
			return reply;
		}

		// Utility: Detect language and default to Spanish
		const getLanguage = (text: string): string => {
			const langs = lngDetector.detect(text, 4);

			const lang = langs[0]?.[0] || 'es';
			return lang === 'english' ? 'en' : 'es';
		};

		// Command: Start
		bot.command('start', (ctx: Context) => {
			const lang = getLanguage(ctx.msg?.text || '');
			ctx.reply(lang === 'es' ? '¡Bienvenido a TipsterX AI!' : 'Welcome to TipsterX AI!');
		});

		// Command: Betting Tip
		bot.command('tips', async (ctx: Context) => {
			const sport = ctx.match || 'football';
			const lang = getLanguage(ctx.msg?.text || '');
			const tip = await generateAIResponse(ctx, `Provide a betting tip for ${sport}`, lang);
			ctx.reply(tip);
		});

		bot.command('leaderboard', (ctx: Context) => {
			const sorted = Object.entries(leaderboard)
				.sort(([, a], [, b]) => b - a)
				.slice(0, 5)
				.map(([user, score], i) => `${i + 1}. ${user}: ${score}`)
				.join('\n');
			const lang = getLanguage(ctx.msg?.text || '');
			ctx.reply(sorted || (lang === 'es' ? 'Tabla vacía' : 'Leaderboard empty'));
		});

		// Command: Meme
		bot.command('meme', async (ctx: Context) => {
			const topic = ctx.match || 'funny';
			const lang = getLanguage(ctx.msg?.text || '');
			const memeText = await generateAIResponse(ctx, `Generate a short, funny meme caption about ${topic}`, lang);
			ctx.reply(memeText);
		});

		// Command: Poll (Challenge)
		bot.command('poll', (ctx: Context) => {
			const question = ctx.match || 'Best team? A, B, C';
			// @ts-expect-error
			const [q, options] = question?.split('?');
			ctx.replyWithPoll(
				q.trim() + '?',
				// @ts-expect-error
				options.split(',').map((o) => o.trim()),
				{ is_anonymous: false },
			);
		});

		// Track engagement
		bot.on('message', async (ctx: Context) => {
			const { hasMention, isReplyToBot } = isBotMentionedOrReplied(ctx);

			if (!ctx?.msg?.text?.startsWith('/')) {
				if (ctx.from) {
					const user = ctx.from.username || ctx.from.first_name;
					leaderboard[user] = (leaderboard[user] || 0) + 1;

					if (ctx.chat?.type === 'group') {
						if (hasMention || isReplyToBot) {
							const lang = getLanguage(ctx.msg?.text || '');
							const response = await generateAIResponse(ctx, ctx.msg?.text || '', lang);
							ctx.replyWithChatAction('typing');
							reply(ctx, response);
						}
						return;
					} else {
						const lang = getLanguage(ctx.msg?.text || '');
						const response = await generateAIResponse(ctx, ctx.msg?.text || '', lang);
						ctx.replyWithChatAction('typing');
						reply(ctx, response);
					}
				}
			}
		});

		bot.catch((err) => {
			console.error(err);
		});

		return webhookCallback(bot, 'cloudflare-mod')(request);
	},
};
