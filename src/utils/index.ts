import type { Bot, Context } from 'grammy';
import type OpenAI from 'openai';
import telegramifyMarkdown from 'telegramify-markdown';
import { PRE_PROMPT } from '../prompt';
import type { ActiveChats, Env } from '../types';

export const sendReply = async (ctx: Context, replyText: string): Promise<void> => {
	try {
		// await ctx.replyWithChatAction('typing');
		await ctx.reply(telegramifyMarkdown(replyText, 'escape'), {
			parse_mode: 'MarkdownV2',
		});
	} catch (error) {
		console.error('Error sending reply:', error);
	}
};

export async function getActiveChats(env: Env): Promise<ActiveChats> {
	const stored = await env.CONVERSATION_HISTORY.get('active_chats');
	if (stored) {
		try {
			return JSON.parse(stored) as ActiveChats;
		} catch (err) {
			console.error('Error parsing active chats:', err);
		}
	}
	return { private: {}, groups: {} };
}

export async function updateActiveChat(env: Env, ctx: Context): Promise<void> {
	if (!ctx.chat?.id) return;

	const activeChats = await getActiveChats(env);
	const chatId = ctx.chat.id.toString();
	const chatType = ctx.chat.type === 'private' ? 'private' : 'group';
	const storage = chatType === 'private' ? activeChats.private : activeChats.groups;

	// Update or create chat entry
	storage[chatId] = {
		id: chatId,
		type: chatType,
		title: ctx.chat.title, // for groups
		username: ctx.chat.type === 'private' ? ctx.chat.username : undefined,
		lastActivity: Date.now(),
	};

	await env.CONVERSATION_HISTORY.put('active_chats', JSON.stringify(activeChats));
}

export async function sendCombinedUpdate(bot: Bot, openai: OpenAI, env: Env) {
	try {
		// Single combined prompt for all updates
		const combinedPrompt = `Generate a comprehensive update with the following sections:

		1. SPORTS NEWS: Latest major sports news, scores, and significant updates from the past 4 hours.
		2. MARKET UPDATE: Key financial markets, crypto trends, and significant market movements.
		3. PRE-MATCH INSIGHTS: Analysis and betting insights for upcoming major sports events if any.

		Format each section clearly and concisely. Let the user know another update will be available in 24 hours. I want up-to-date information, so search the internet for this. Add a title similar to this: 📊 Rojito - IA experto en fijas Update | (${new Date().toUTCString()})

		Again, make sure you search the internet to get accurate and up-to-date information for each section. Ensure that the information is reliable and trustworthy. Verify the sources and cross-check the data before providing the information.

		## Requirements
		- Data Freshness:

			- Source all information from the internet, ensuring data is no older than 24 hours.

			- Verify and cross-check sources for reliability (e.g., reputable sports outlets like ESPN, financial news like Bloomberg).

			- If no relevant data is found within 4 hours for sports news, use the most recent data within 24 hours, clearly stating the timeframe.

		Respond in Spanish
		`;

		// Single API call for all updates
		const response = await openai.chat.completions.create({
			// temperature: 0.5,
			model: 'gpt-4o-search-preview',
			web_search_options: {
				search_context_size: 'high',
			},
			messages: [
				{
					role: 'developer',
					content: PRE_PROMPT,
				},
				{
					role: 'developer',
					content: combinedPrompt,
				},
			],
		});

		// Format the response
		const formattedUpdate = `${response.choices[0].message.content}`;

		// Store the update
		const combinedUpdate = {
			content: formattedUpdate,
			timestamp: Date.now(),
		};
		await env.CONVERSATION_HISTORY.put('last_combined_update', JSON.stringify(combinedUpdate));

		// Get active chats and send updates
		const activeChats = await getActiveChats(env);

		// Send to group chats
		for (const [id, chat] of Object.entries(activeChats.groups)) {
			try {
				const res = await bot.api.sendMessage(id, telegramifyMarkdown(formattedUpdate, 'escape'), {
					parse_mode: 'MarkdownV2',
				});
			} catch (error) {
				console.error(`Failed to send update to group ${id}:`, error);
			}
		}
	} catch (error) {
		console.error('Error sending combined update:', error);
	}
}
