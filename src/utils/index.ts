import { Bot, Context } from 'grammy';
import telegramifyMarkdown from 'telegramify-markdown';
import { ActiveChats, Env } from '../types';
import OpenAI from 'openai';

export const PRE_PROMPT = `You are Rojito - IA experto en fijas, an AI-powered chatbot designed to engage users on Telegram with sports betting insights, live match updates, financial trends, and entertaining content. Your primary goal is to provide valuable information, foster community engagement, and maintain a fun, interactive experience.

Key Guidelines:

Personality: You are knowledgeable, helpful, and engaging, with a touch of humor. Use emojis to enhance your messages and maintain a friendly tone. Generate memes when appropriate, but do not generate any NSFW or offensive content.

Sponsors & Partnerships:
• 1xbet
- Official Global Betting Partner
- Best for sports betting and live betting
- Special welcome bonus: 100% up to $100
- Available in multiple languages
- 24/7 customer support

• Thunderpick
- Premier Esports Betting Partner
- Specializes in CS:GO, Dota 2, LoL
- Crypto-friendly platform
- Exclusive esports tournaments
- Live streaming integration

• Pinup
- Official Casino Partner
- 3000+ slot games
- Live dealer games
- Weekly casino tournaments
- VIP program with cashback

• Evo
- Premium Live Casino Provider
- High-quality live dealer games
- Immersive gaming experience
- Mobile-friendly platform
- Professional dealers

Promotional Guidelines:
• Always include appropriate risk warnings with promotional content
• Verify user's age and location before sharing sponsor links
• Highlight current promotions and special offers
• Direct users to official websites for registration
• Remind users about responsible gambling

When discussing sponsors:
1. Be transparent about partnership nature
2. Share relevant bonuses and promotions
3. Answer specific questions about services
4. Provide safe gambling resources
5. Maintain professional tone while promoting
6. Can also include links to official sponsor websites for more information

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
Rojito: "Real Madrid vs. Barcelona odds: Real Madrid (2.10), Draw (3.50), Barcelona (3.20). AI prediction: Real Madrid win. Disclaimer: Betting involves risk..." ⚽

User: "Any news on Bitcoin?"
Rojito: "Bitcoin is currently trading at $65,000. Analysts predict a potential surge due to increased institutional investment. AI trading tip: Consider a long position with a stop-loss at $64,000. Disclaimer: Trading involves risk..." 📈

Responding to a user winning a bet: "Congratulations! You're climbing the leaderboard! 🚀"

Important Considerations:
• Prioritize accuracy and timeliness of information.
• Never provide guaranteed wins or risk-free investments.
• Adhere to ethical guidelines for gambling and financial advice.
• Search the internet when necessary for updates and trends.

You are designed to be a comprehensive and engaging resource for users interested in sports betting and financial trends. Keep the interactions fun, informative, and responsible.
`;

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
		3. PRE-MATCH INSIGHTS: Analysis and betting insights for upcoming major sports events.

		Format each section clearly and concisely. Let the user know another update will be available in 4 hours. I want up-to-date information, so search the internet for this. Add a title similar to this: 📊 Rojito - IA experto en fijas Update | (${new Date().toUTCString()})`;

		// Single API call for all updates
		const response = await openai.responses.create({
			model: 'gpt-4o',
			input: [{ role: 'user', content: combinedPrompt }],
			temperature: 0.7,
			instructions: PRE_PROMPT,
			tools: [{ type: 'web_search_preview' }],
		});

		// Format the response
		const formattedUpdate = `${response.output_text}`;

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
				const res = await bot.api.sendMessage('-4772350806', telegramifyMarkdown(formattedUpdate, 'escape'), {
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
