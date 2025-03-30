import { Bot, Context, webhookCallback } from 'grammy';
import LanguageDetect from 'languagedetect';
import OpenAI from 'openai';
import telegramifyMarkdown from 'telegramify-markdown';
import { ResponseCreateParamsNonStreaming, ResponseInput } from 'openai/src/resources/responses/responses.js';

export interface Env {
	BOT_INFO: string;
	BOT_TOKEN: string;
	OPENAI_API_KEY: string;
	CONVERSATION_HISTORY: KVNamespace;
	LEADERBOARD: KVNamespace;
	USER_LANGUAGE: KVNamespace;
}

type MessageRole = 'user' | 'assistant';
interface ConversationMessage {
	role: MessageRole;
	content: string;
}

//
// KV STORAGE FUNCTIONS (for conversation history)
//

async function getConversationHistory(env: Env, key: string): Promise<ConversationMessage[]> {
	const stored = await env.CONVERSATION_HISTORY.get(key);
	if (stored) {
		try {
			return JSON.parse(stored) as ConversationMessage[];
		} catch (err) {
			console.error(`Error parsing conversation history for ${key}:`, err);
		}
	}
	return [];
}

async function updateConversationHistory(env: Env, key: string, message: ConversationMessage): Promise<void> {
	const history = await getConversationHistory(env, key);
	history.push(message);
	// Keep only the last 5 messages to manage token usage.
	if (history.length > 5) history.shift();
	await env.CONVERSATION_HISTORY.put(key, JSON.stringify(history));
}

//
// KV STORAGE FUNCTIONS (for leaderboard)
//

async function getLeaderboard(env: Env): Promise<Record<string, number>> {
	const stored = await env.LEADERBOARD.get('globalLeaderboard');
	if (stored) {
		try {
			return JSON.parse(stored) as Record<string, number>;
		} catch (err) {
			console.error('Error parsing leaderboard data:', err);
		}
	}
	return {};
}

async function updateLeaderboard(env: Env, username: string): Promise<void> {
	const leaderboard = await getLeaderboard(env);
	leaderboard[username] = (leaderboard[username] || 0) + 1;
	await env.LEADERBOARD.put('globalLeaderboard', JSON.stringify(leaderboard));
}

//
// OTHER UTILITY FUNCTIONS
//

// Returns a conversation key based on chat type.
const getConversationKey = (ctx: Context): string => (ctx.chat?.type === 'group' ? `group:${ctx.chat.id}` : `user:${ctx.from?.id}`);

const lngDetector = new LanguageDetect();
const getLanguage = (text: string): string => {
	const langs = lngDetector.detect(text, 4);
	const lang = langs[0]?.[0] || 'es';
	return lang.toLowerCase() === 'english' ? 'en' : 'es';
};

const sendReply = async (ctx: Context, replyText: string): Promise<void> => {
	try {
		await ctx.replyWithChatAction('typing');
		await ctx.reply(telegramifyMarkdown(replyText, 'escape'), {
			parse_mode: 'MarkdownV2',
		});
	} catch (error) {
		console.error('Error sending reply:', error);
	}
};

//
// AI RESPONSE GENERATION
//

async function generateAIResponse(ctx: Context, prompt: string, openai: OpenAI, PRE_PROMPT: string, env: Env): Promise<string> {
	const key = getConversationKey(ctx);
	const history = await getConversationHistory(env, key);
	const language = getUserLanguage(env, ctx.from?.id);

	// Assemble input with any prior history.
	const input: ResponseCreateParamsNonStreaming['input'] = [
		...history, // conversation history from KV.
		{ role: 'user', content: `${prompt}` },
	];

	// If replying to a message that has text, add it as context.
	const highlightedText = ctx.msg?.reply_to_message?.text;
	if (highlightedText) {
		// Insert context before the current prompt.
		input.splice(input.length - 1, 0, {
			role: 'user',
			content: `Context from a previous message I'm replying to: "${highlightedText}"`,
		});
	}

	// Update conversation history with the user's prompt.
	await updateConversationHistory(env, key, { role: 'user', content: prompt });

	try {
		const response = await openai.responses.create({
			model: 'gpt-4o',
			input,
			temperature: 0.5,
			instructions: `${PRE_PROMPT} respond in ${language} unless specified otherwise.`,
			tools: [{ type: 'web_search_preview' }],
		});
		const replyText = response.output_text || 'Error generating response';
		// Update conversation history with the assistant's reply.
		await updateConversationHistory(env, key, { role: 'assistant', content: replyText });
		return replyText;
	} catch (err) {
		console.error('Error generating AI response:', err);
		return 'There was an error generating a response. Please try again later.';
	}
}

const supportedLanguages = [
	{ code: 'en', label: 'English' },
	{ code: 'es', label: 'Spanish' },
	{ code: 'pt', label: 'Portuguese' },
	{ code: 'ko', label: 'Korean' },
];

// KV helper functions for user language preferences.
async function setUserLanguage(env: Env, userId: number, lang: string): Promise<void> {
	await env.USER_LANGUAGE.put(`user_language:${userId}`, lang);
}
async function getUserLanguage(env: Env, userId: number | undefined): Promise<string> {
	if (!userId) return 'es';
	return (await env.USER_LANGUAGE.get(`user_language:${userId}`)) || 'es';
}

//
// MAIN FUNCTION
//

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === 'GET' && url.pathname === '/') {
			return new Response('TipsterX Bot is running on Cloudflare Workers.', { status: 200 });
		}

		// Initialize the bot with the provided token and bot info.
		const botInfo = JSON.parse(env.BOT_INFO);
		const bot = new Bot(env.BOT_TOKEN, { botInfo });
		const BOT_USERNAME = botInfo.username;
		const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

		// Pre-prompt defining the bot's role and guidelines.
		const PRE_PROMPT = `You are TipsterX, an AI-powered chatbot designed to engage users on Telegram with sports betting insights, live match updates, financial trends, and entertaining content. Your primary goal is to provide valuable information, foster community engagement, and maintain a fun, interactive experience.

Key Guidelines:

Personality: You are knowledgeable, helpful, and engaging, with a touch of humor. Use emojis to enhance your messages and maintain a friendly tone. Generate memes when appropriate, but do not generate any NSFW or offensive content.

Functionality:
• Sports Betting & Match Insights: Provide live scores, past results, and AI-powered betting tips for major leagues (Premier League, La Liga, Champions League, NBA, NFL, etc.). Offer real-time odds updates.
• Trading & Finance Trends: Offer insights on crypto, stocks, and market trends. Generate AI-driven trading tips based on live data.
• Engagement: Share AI-generated memes related to sports & betting. Maintain leaderboards to track top bettors and active users. Run polls and challenges to encourage community participation.
• Multi-Language Support: You can respond in English, Spanish, Portuguese, and Korean. Detect the user's language and respond accordingly. If you cannot detect it, default to English.
• Automated Updates: Send live sports and finance news updates every 4 hours. Provide pre-match insights and betting tips before significant games.

Internet Search & Data Cleaning:
• Search the internet for up-to-date data on sports betting, match results, odds, and financial trends.
• Extract relevant and accurate information from reliable sources.
• Clean the data by removing duplicates, irrelevant details, and outdated information.
• Summarize the cleaned data into concise, actionable insights for users.
• Always verify the credibility of sources before sharing information.

Response Style:
• Be concise and informative.
• Use bullet points or numbered lists to present information clearly.
• Incorporate relevant emojis to add personality and visual appeal.
• When providing betting or trading tips, always include a disclaimer: "Disclaimer: Betting and trading involve risk. Only bet or trade what you can afford to lose."

Example Interactions:

User: "What are the odds for the Real Madrid game?"
TipsterX: "Real Madrid vs. Barcelona odds: Real Madrid (2.10), Draw (3.50), Barcelona (3.20). AI prediction: Real Madrid win. Disclaimer: Betting involves risk..." ⚽

User: "Any news on Bitcoin?"
TipsterX: "Bitcoin is currently trading at $65,000. Analysts predict a potential surge due to increased institutional investment. AI trading tip: Consider a long position with a stop-loss at $64,000. Disclaimer: Trading involves risk..." 📈

Responding to a user winning a bet: "Congratulations! You're climbing the leaderboard! 🚀"

Important Considerations:
• Prioritize accuracy and timeliness of information.
• Never provide guaranteed wins or risk-free investments.
• Adhere to ethical guidelines for gambling and financial advice.
• Search the internet when necessary for updates and trends.

You are designed to be a comprehensive and engaging resource for users interested in sports betting and financial trends. Keep the interactions fun, informative, and responsible.
`;

		// Utility: Check if the bot is directly mentioned or replied to.
		const isBotMentionedOrReplied = (ctx: Context): { hasMention: boolean; isReplyToBot: boolean } => {
			const text = ctx.msg?.text || '';
			const entities = ctx.msg?.entities || [];
			const replyToMessage = ctx.msg?.reply_to_message;

			const hasMention = entities.some((entity) => {
				return entity.type === 'mention' && text.slice(entity.offset, entity.offset + entity.length) === `@${BOT_USERNAME}`;
			});
			const isReplyToBot = replyToMessage?.from?.username === BOT_USERNAME && replyToMessage?.from?.is_bot;
			return { hasMention, isReplyToBot };
		};

		// COMMAND: /start
		bot.command('start', async (ctx: Context) => {
			await ctx.reply('Welcome! Please select your preferred language:', {
				reply_markup: {
					inline_keyboard: [
						supportedLanguages.map((lang) => ({
							text: lang.label,
							callback_data: `set_language:${lang.code}`,
						})),
					],
				},
			});
		});

		// COMMAND: /tips – Provide a betting tip.
		bot.command('tips', async (ctx: Context) => {
			const sport = (ctx.match || 'football').trim();
			const tip = await generateAIResponse(ctx, `Provide a betting tip for ${sport}`, openai, PRE_PROMPT, env);
			await ctx.reply(tip);
		});

		// COMMAND: /leaderboard – Show top users.
		bot.command('leaderboard', async (ctx: Context) => {
			const leaderboardData = await getLeaderboard(env);
			const sorted = Object.entries(leaderboardData)
				.sort(([, a], [, b]) => b - a)
				.slice(0, 5)
				.map(([user, score], i) => `${i + 1}. ${user}: ${score}`)
				.join('\n');

			const lang = await getUserLanguage(env, ctx.from?.id);
			let msg = '';
			switch (lang) {
				case 'es':
					msg = 'Tabla vacía';
					break;
				case 'en':
					msg = 'Leaderboard empty';
					break;
				case 'pt':
					msg = 'Placar vazio';
					break;
				case 'ko':
					msg = '리더보드 비어있음';
					break;
				default:
					msg = 'Leaderboard empty';
					break;
			}
			await ctx.reply(sorted || msg);
		});

		// COMMAND: /meme – Generate a funny meme caption.
		bot.command('meme', async (ctx: Context) => {
			const topic = (ctx.match || 'funny').trim();
			const memeText = await generateAIResponse(ctx, `Generate a short, funny meme caption about ${topic}`, openai, PRE_PROMPT, env);
			await ctx.reply(memeText);
		});

		// COMMAND: /language – Select language.
		bot.command('language', async (ctx: Context) => {
			await ctx.reply('Please select your language:', {
				reply_markup: {
					inline_keyboard: [
						supportedLanguages.map((lang) => ({
							text: lang.label,
							callback_data: `set_language:${lang.code}`,
						})),
					],
				},
			});
		});

		// COMMAND: /poll – Create a poll.
		bot.command('poll', async (ctx: Context) => {
			const question = ctx.match || 'Best team? A, B, C';
			// Basic input validation; expecting a string with a '?' and options comma-separated.
			const split = question.split('?');
			if (split.length < 2) {
				await ctx.reply('Invalid format. Please use "Question? Option1, Option2, Option3"');
				return;
			}
			const q = split[0].trim();
			const options = split[1]
				.split(',')
				.map((option) => option.trim())
				.filter(Boolean);
			if (!q || options.length < 2) {
				await ctx.reply('Invalid format. Ensure a valid question and at least two options.');
				return;
			}
			try {
				await ctx.replyWithPoll(q + '?', options, { is_anonymous: false });
			} catch (error) {
				console.error('Error creating poll:', error);
				await ctx.reply('Error creating poll. Please try again.');
			}
		});

		// Event: On receiving a message (for engagement and AI responses).
		bot.on('message', async (ctx: Context) => {
			// Only process non-command messages.
			if (ctx.msg?.text?.startsWith('/')) return;

			if (ctx.from) {
				// Update leaderboard in KV storage.
				const username = ctx.from.username || ctx.from.first_name || 'unknown';
				await updateLeaderboard(env, username);
			}

			const { hasMention, isReplyToBot } = isBotMentionedOrReplied(ctx);

			// In groups, only respond when mentioned or when replying to the bot.
			if (ctx.chat?.type === 'group' && !(hasMention || isReplyToBot)) return;

			const answer = await generateAIResponse(ctx, ctx.msg?.text || '', openai, PRE_PROMPT, env);
			await sendReply(ctx, answer);
		});

		// Handle callback for language selection
		bot.on('callback_query:data', async (ctx: Context) => {
			const data = ctx?.callbackQuery?.data || '';
			if (data.startsWith('set_language:')) {
				const langCode = data.split(':')[1];
				const selected = supportedLanguages.find((lang) => lang.code === langCode);
				if (ctx?.callbackQuery?.from && selected) {
					await setUserLanguage(env, ctx.callbackQuery.from.id, langCode);
					await ctx.answerCallbackQuery({ text: `Language set to ${selected.label}.` });
					if (ctx.chat?.type === 'private') {
						await ctx.reply(`${selected.label} language selected.`);
					}
				} else {
					await ctx.answerCallbackQuery({ text: 'Unknown language selected.' });
				}
			}
		});

		// Global bot error handling.
		bot.catch((err) => {
			console.error('Bot encountered an error:', err);
		});

		// Return the webhook callback handling result.
		return webhookCallback(bot, 'cloudflare-mod')(request);
	},
};
