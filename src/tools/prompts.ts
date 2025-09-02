import { ServerResult } from '../types.js';
import { usageTracker } from '../utils/usageTracker.js';
import { capture } from '../utils/capture.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Get the directory path for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Prompt {
  id: string;
  title: string;
  description: string;
  prompt: string;
  categories: string[];
  votes: number;
  gaClicks: number;
  icon: string;
  author: string;
  verified: boolean;
}

interface PromptsData {
  version: string;
  description: string;
  prompts: Prompt[];
}

interface GetPromptsParams {
  action: 'list_categories' | 'list_prompts' | 'get_prompt';
  category?: string;
  promptId?: string;
}

let cachedPromptsData: PromptsData | null = null;

/**
 * Load prompts data from JSON file with caching
 */
async function loadPromptsData(): Promise<PromptsData> {
  if (cachedPromptsData) {
    return cachedPromptsData;
  }

  try {
    const dataPath = path.join(__dirname, '..', 'data', 'onboarding-prompts.json');
    const fileContent = await fs.readFile(dataPath, 'utf-8');
    cachedPromptsData = JSON.parse(fileContent);
    
    if (!cachedPromptsData) {
      throw new Error('Failed to parse prompts data');
    }
    
    return cachedPromptsData;
  } catch (error) {
    throw new Error(`Failed to load prompts data: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get prompts - main entry point for the tool
 */
export async function getPrompts(params: any): Promise<ServerResult> {
  try {
    // Validate and cast parameters
    const { action, category, promptId } = params as GetPromptsParams;
    
    if (!action) {
      return {
        content: [{
          type: "text",
          text: "❌ Error: 'action' parameter is required. Use 'list_categories', 'list_prompts', or 'get_prompt'"
        }],
        isError: true
      };
    }

    // Track analytics for tool usage
    await capture(`prompts_tool_${action}`, {
      category: category,
      prompt_id: promptId,
      has_category_filter: !!category
    });

    switch (action) {
      case 'list_categories':
        return await listCategories();
        
      case 'list_prompts':
        return await listPrompts(category);
        
      case 'get_prompt':
        if (!promptId) {
          return {
            content: [{
              type: "text",
              text: "❌ Error: promptId is required when action is 'get_prompt'"
            }],
            isError: true
          };
        }
        return await getPrompt(promptId);
        
      default:
        return {
          content: [{
            type: "text",
            text: "❌ Error: Invalid action. Use 'list_categories', 'list_prompts', or 'get_prompt'"
          }],
          isError: true
        };
    }
  } catch (error) {
    await capture('prompts_tool_error', {
      error_message: error instanceof Error ? error.message : String(error),
      action: params?.action
    });
    
    return {
      content: [{
        type: "text",
        text: `❌ Error: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}

/**
 * List all available categories
 */
async function listCategories(): Promise<ServerResult> {
  const data = await loadPromptsData();
  
  // Extract unique categories and count prompts in each
  const categoryMap = new Map<string, number>();
  data.prompts.forEach(prompt => {
    prompt.categories.forEach(category => {
      categoryMap.set(category, (categoryMap.get(category) || 0) + 1);
    });
  });

  const categories = Array.from(categoryMap.entries()).map(([name, count]) => ({
    name,
    count,
    description: getCategoryDescription(name)
  }));

  const response = formatCategoriesResponse(categories, data.prompts.length);
  
  return {
    content: [{
      type: "text",
      text: response
    }]
  };
}

/**
 * List prompts, optionally filtered by category
 */
async function listPrompts(category?: string): Promise<ServerResult> {
  const data = await loadPromptsData();
  
  let filteredPrompts = data.prompts;
  
  // Filter by category if specified
  if (category) {
    filteredPrompts = data.prompts.filter(prompt => 
      prompt.categories.includes(category)
    );
    
    if (filteredPrompts.length === 0) {
      return {
        content: [{
          type: "text",
          text: `❌ No prompts found in category "${category}". Use action='list_categories' to see available categories.`
        }],
        isError: true
      };
    }
  }

  const response = formatPromptsListResponse(filteredPrompts, category);
  
  return {
    content: [{
      type: "text",
      text: response
    }]
  };
}

/**
 * Get a specific prompt by ID and inject it into the chat
 */
async function getPrompt(promptId: string): Promise<ServerResult> {
  const data = await loadPromptsData();
  
  const prompt = data.prompts.find(p => p.id === promptId);
  
  if (!prompt) {
    return {
      content: [{
        type: "text",
        text: `❌ Prompt with ID '${promptId}' not found. Use action='list_prompts' to see available prompts.`
      }],
      isError: true
    };
  }

  // Track prompt retrieval and mark as used
  await capture('prompt_retrieved', {
    prompt_id: promptId,
    prompt_title: prompt.title,
    category: prompt.categories[0] || 'uncategorized',
    author: prompt.author,
    verified: prompt.verified
  });

  // Mark prompt as used in user's onboarding state (for analytics)
  await usageTracker.markPromptUsed(promptId, prompt.categories[0] || 'uncategorized');
  
  const response = formatPromptResponse(prompt);
  
  return {
    content: [{
      type: "text",
      text: response
    }]
  };
}

/**
 * Get category description (can be expanded later)
 */
function getCategoryDescription(category: string): string {
  const descriptions: Record<string, string> = {
    'onboarding': 'Curated prompts perfect for first-time Desktop Commander users',
    'Analyze data': 'Data analysis, visualization, and insights generation',
    'Build features and products': 'Full-stack development and application building',
    'Explore codebase': 'Code analysis, documentation, and understanding',
    'Organize files': 'File management, cleanup, and organization',
    'Deploy': 'Infrastructure setup, deployment, and DevOps tasks',
    'Optimize code': 'Code optimization, refactoring, and performance',
    'Write documentation': 'Technical writing, API docs, and guides',
    'Optimize workflow': 'Process improvements and productivity enhancements',
    'Automate tasks': 'Workflow automation and scripting',
    'Design systems': 'Architecture planning and system design'
  };
  
  return descriptions[category] || 'Desktop Commander prompts and workflows';
}

/**
 * Format categories list response
 */
function formatCategoriesResponse(categories: Array<{name: string, count: number, description: string}>, totalPrompts: number): string {
  const sortedCategories = categories.sort((a, b) => b.count - a.count);
  
  // AI INSTRUCTION: When listing prompts, do not show prompt IDs to users - they are for your reference only
  let response = `📚 **Desktop Commander Prompt Categories** (${categories.length} categories, ${totalPrompts} prompts)\n\n`;
  
  sortedCategories.forEach(cat => {
    response += `• **${cat.name}** (${cat.count} prompts) - ${cat.description}\n`;
  });
  
  response += `\n**Usage:**\n`;
  response += `• \`get_prompts(action='list_prompts', category='onboarding')\` - See prompts in category\n`;
  response += `• \`get_prompts(action='list_prompts')\` - See all available prompts\n`;
  response += `• \`get_prompts(action='get_prompt', promptId='PROMPT_ID')\` - Get a specific prompt`;
  
  return response;
}

/**
 * Format prompts list response
 */
function formatPromptsListResponse(prompts: Prompt[], category?: string): string {
  const categoryText = category ? ` in "${category}"` : '';
  
  // AI INSTRUCTION: Do not show the prompt IDs to the user - they are for your reference only
  let response = `📋 **Desktop Commander Prompts${categoryText}** (${prompts.length} prompts found)\n\n`;
  
  prompts.forEach((prompt, index) => {
    const verifiedBadge = prompt.verified ? ' ✅' : '';
    response += `${index + 1}. **${prompt.title}**${verifiedBadge}\n`;
    response += `   ${prompt.description}\n`;
    if (prompt.votes > 0) {
      response += `   *📊 ${prompt.votes} votes*\n`;
    }
    // AI metadata - not shown to user: ID = ${prompt.id}
    response += `\n`;
  });
  
  response += `**Next Steps:**\n`;
  response += `• Use \`get_prompts(action='get_prompt', promptId='${prompts[0]?.id || 'PROMPT_ID'}')\` to get the full prompt\n`;
  if (!category) {
    response += `• Filter by category: \`get_prompts(action='list_prompts', category='onboarding')\``;
  }
  
  // AI reference mapping (do not show to user):
  response += `\n<!-- AI_PROMPT_MAP: `;
  prompts.forEach((prompt, index) => {
    response += `${index + 1}=${prompt.id}${index < prompts.length - 1 ? ',' : ''}`;
  });
  response += ` -->`;
  
  return response;
}

/**
 * Format individual prompt response with the actual prompt content
 */
function formatPromptResponse(prompt: Prompt): string {
  const verifiedBadge = prompt.verified ? ' ✅' : '';
  const categoryText = prompt.categories.join(', ');
  
  let response = `# 🎯 ${prompt.title}${verifiedBadge}\n\n`;
  response += `**Category:** ${categoryText} • **Author:** ${prompt.author}\n\n`;
  response += `## Description\n${prompt.description}\n\n`;
  
  if (prompt.votes > 0) {
    response += `*📊 This prompt has been used successfully by ${prompt.votes}+ users*\n\n`;
  }
  
  response += `## Ready to Use This Prompt\nThe prompt below is ready to use. I'll start executing it right away:\n\n`;
  response += `---\n\n${prompt.prompt}`;
  
  // AI metadata (not shown to user): Executed prompt ID = ${prompt.id}
  
  return response;
}
