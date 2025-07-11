import { Bot, type Context, webhookCallback } from 'grammy';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/index.js';
import { PRE_PROMPT } from './prompt';
import type { ConversationMessage, Env } from './types';
import { sendCombinedUpdate, sendReply, updateActiveChat } from './utils';

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

//
// AI RESPONSE GENERATION
//

async function generateAIResponse(ctx: Context, prompt: string, openai: OpenAI, PRE_PROMPT: string, env: Env): Promise<string> {
	const key = getConversationKey(ctx);
	const history = await getConversationHistory(env, key);
	const language = await getUserLanguage(env, ctx.from?.id);

	// Assemble input with any prior history.
	const input: ChatCompletionMessageParam[] = [
		...history, // conversation history from KV.
		{
			role: 'user',
			content: `Respond in ${supportedLanguages.find((lang) => lang.code === language)?.label ?? 'Spanish'}. ${prompt}`,
		},
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
		const response = await openai.chat.completions.create({
			// temperature:
			model: 'gpt-4o-search-preview',
			web_search_options: {
				search_context_size: 'high',
			},
			messages: [
				{
					role: 'system',
					content:
						'You are Rojito - IA experto en fijas, a chatbot designed to engage users on Telegram with sports betting insights, live match updates, financial trends, and entertaining content. Your primary goal is to provide valuable information, foster community engagement, and maintain a fun, interactive experience. For all other questions that are out of the scope of these sectors, please respond with a polite message that the question is out of your scope.',
				},
				{
					role: 'developer',
					content: PRE_PROMPT,
				},
				...input,
			],
		});

		const replyText = response.choices[0].message.content || 'Error generating response';
		// Update conversation history with the assistant's reply.
		await updateConversationHistory(env, key, { role: 'assistant', content: replyText });
		return replyText;
	} catch (err) {
		console.error('Error generating AI response:', err);
		console.log(JSON.stringify(err));
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
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		const botInfo = JSON.parse(env.BOT_INFO);
		const bot = new Bot(env.BOT_TOKEN, { botInfo });
		const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
		const currentHour = new Date().getUTCHours();

		// Send combined updates every 4 hours
		if (currentHour % 4 === 0) {
			await sendCombinedUpdate(bot, openai, env);
			// await cleanInactiveChats(env); // Clean inactive chats once per day
		}

		return new Response('Scheduled updates completed', { status: 200 });
	},
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Initialize the bot with the provided token and bot info.
		const botInfo = JSON.parse(env.BOT_INFO);
		const bot = new Bot(env.BOT_TOKEN, { botInfo });
		const BOT_USERNAME = botInfo.username;
		const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
		const url = new URL(request.url);

		if (request.method === 'GET' && url.pathname === '/') {
			return new Response('Rojito - IA experto en fijas is running on Cloudflare Workers.', { status: 200 });
		}

		// Utility: Check if the bot is directly mentioned or replied to.
		const isBotMentionedOrReplied = (ctx: Context): { hasMention: boolean; isReplyToBot: boolean } => {
			const text = ctx.msg?.text || '';
			const entities = ctx.msg?.entities || [];
			const replyToMessage = ctx.msg?.reply_to_message;

			const hasMention = entities.some((entity) => {
				return entity.type === 'mention' && text.slice(entity.offset, entity.offset + entity.length) === `@${BOT_USERNAME}`;
			});
			const isReplyToBot = Boolean(replyToMessage?.from?.username === BOT_USERNAME && replyToMessage?.from?.is_bot);
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

		// Event: On user joining the group.
		// bot.on('message:new_chat_members', async (ctx) => {
		// 	const newMembers = ctx.message.new_chat_members;
		// 	for (const member of newMembers) {
		// 		const username = member.username || member.first_name || 'user';
		// 		await ctx.reply(`Welcome to the group, ${username}!`);
		// 	}
		// });

		// Event: On receiving a message (for engagement and AI responses).
		bot.on('message', async (ctx: Context) => {
			const { hasMention, isReplyToBot } = isBotMentionedOrReplied(ctx);
			// Only process non-command messages.
			if (ctx.msg?.text?.startsWith('/')) return;
			// also don't respond for when user joins the group
			if (ctx.chat?.type === 'group' && ctx.msg?.new_chat_members?.length) return;
			console.log('CTX', JSON.stringify(ctx, null, 2));

			// In groups, only respond when mentioned or when replying to the bot. In private chats, always reply
			if ((ctx.chat?.type === 'group' && (hasMention || isReplyToBot)) || ctx.chat?.type === 'private') {
				await updateActiveChat(env, ctx);

				if (ctx.from) {
					// Update leaderboard in KV storage.
					const username = ctx.from.username || ctx.from.first_name || 'unknown';
					await updateLeaderboard(env, username);
				}

				const answer = await generateAIResponse(ctx, ctx.msg?.text || '', openai, PRE_PROMPT, env);
				await sendReply(ctx, answer);
			}
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
					// delete msg after
					await ctx.deleteMessage();
					// if (ctx.chat?.type === 'private') {
					// 	await ctx.reply(`${selected.label} language selected.`);
					// }
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
