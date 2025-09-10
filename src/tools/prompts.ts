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
  secondaryTag?: string;
  votes: number;
  gaClicks: number;
  icon: string;
  author: string;
  verified: boolean;
}

export interface PromptsData {
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
 * Clear cached prompts data (for development/testing)
 */
function clearCache(): void {
  cachedPromptsData = null;
}

/**
 * Load prompts data from JSON file with caching
 */
export async function loadPromptsData(): Promise<PromptsData> {
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

    // No separate analytics here - will be captured by server tool call tracking with parameters

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
    // Error will be captured by server tool call tracking
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
 * Format prompts list response using secondary tags for clean organization
 */
function formatPromptsListResponse(prompts: Prompt[], category?: string): string {
  const categoryText = category ? ` in "${category}"` : '';
  
  let response = `Desktop Commander Examples${categoryText}\n\n`;
  
  // Group by secondary tag
  const groupedPrompts = new Map<string, Prompt[]>();
  prompts.forEach(prompt => {
    const tag = prompt.secondaryTag || 'Other';
    if (!groupedPrompts.has(tag)) {
      groupedPrompts.set(tag, []);
    }
    groupedPrompts.get(tag)!.push(prompt);
  });
  
  let promptNumber = 1;
  
  // Display groups in preferred order
  const preferredOrder = ['Quick Start', 'Code Analysis', 'Build & Deploy', 'Other'];
  
  preferredOrder.forEach(tag => {
    if (groupedPrompts.has(tag)) {
      const tagPrompts = groupedPrompts.get(tag)!;
      // Add emoji for each section
      const emoji = tag === 'Quick Start' ? '🚀' : tag === 'Code Analysis' ? '💻' : tag === 'Build & Deploy' ? '🔨' : '📋';
      response += `**${emoji} ${tag}**\n`;
      tagPrompts.forEach(prompt => {
        response += `• ${promptNumber}. ${prompt.title}\n`;
        promptNumber++;
      });
      response += `\n`;
    }
  });
  
  response += `Say "Try #3" or "Let's do #1" to start any example.\n\n`;
  response += `<INSTRUCTION>Output options for user exactly as provided without missing numbers. 
Its important so user can choose an options by entering number only. Also do not forget new lines between numbers for easy reading</INSTRUCTION>\n\n`;

  // AI reference mapping (do not show to user):
  response += `<!-- AI_PROMPT_MAP: `;
  let mapNumber = 1;
  preferredOrder.forEach(tag => {
    if (groupedPrompts.has(tag)) {
      groupedPrompts.get(tag)!.forEach(prompt => {
        response += `${mapNumber}=${prompt.id}${mapNumber < prompts.length ? ',' : ''}`;
        mapNumber++;
      });
    }
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
