import { createSupabaseServiceClient } from '../../utils/supabase.js';
import { z } from 'zod';

/**
 * Supabase query tool - execute read-only queries on allowed tables
 */
export class SupabaseQueryTool {
  static getDefinition() {
    return {
      name: 'supabase_query',
      description: 'Execute read-only queries on Supabase tables with user context',
      inputSchema: z.object({
        table: z.enum(['mcp_sessions', 'mcp_tool_calls']).describe('Table name to query'),
        columns: z.string().default('*').describe('Columns to select (default: *)'),
        filters: z.record(z.any()).default({}).describe('Filter conditions (key-value pairs)'),
        order_by: z.string().optional().describe('Column to order by'),
        order_direction: z.enum(['asc', 'desc']).default('desc').describe('Order direction'),
        limit: z.number().min(1).max(100).default(10).describe('Limit number of results')
      })
    };
  }

  static async execute(params, user, supabase) {
    const {
      table,
      columns = '*',
      filters = {},
      order_by,
      order_direction = 'desc',
      limit = 10
    } = params;

    try {
      // Use service client for database access
      const serviceSupabase = createSupabaseServiceClient();

      // Build query
      let query = serviceSupabase.from(table).select(columns);

      // Apply user context filter (RLS-like behavior)
      query = query.eq('user_id', user.id);

      // Apply additional filters
      Object.entries(filters).forEach(([key, value]) => {
        if (key !== 'user_id') { // Prevent overriding user_id filter
          if (value === null) {
            query = query.is(key, null);
          } else if (Array.isArray(value)) {
            query = query.in(key, value);
          } else if (typeof value === 'object' && value.operator) {
            // Support for advanced operators
            switch (value.operator) {
              case 'gt':
                query = query.gt(key, value.value);
                break;
              case 'gte':
                query = query.gte(key, value.value);
                break;
              case 'lt':
                query = query.lt(key, value.value);
                break;
              case 'lte':
                query = query.lte(key, value.value);
                break;
              case 'like':
                query = query.like(key, value.value);
                break;
              case 'ilike':
                query = query.ilike(key, value.value);
                break;
              default:
                query = query.eq(key, value.value);
            }
          } else {
            query = query.eq(key, value);
          }
        }
      });

      // Apply ordering
      if (order_by) {
        query = query.order(order_by, { ascending: order_direction === 'asc' });
      }

      // Apply limit
      if (limit) {
        query = query.limit(Math.min(limit, 100)); // Cap at 100 records
      }

      // Execute query
      const { data, error } = await query;

      if (error) {
        throw new Error(`Query failed: ${error.message}`);
      }

      // Format response
      const response = {
        table,
        filters: { ...filters, user_id: user.id },
        count: data.length,
        data: data
      };

      // Add summary for tool calls
      if (table === 'mcp_tool_calls' && data.length > 0) {
        const toolCounts = {};
        let successCount = 0;
        let totalDuration = 0;

        data.forEach(call => {
          toolCounts[call.tool_name] = (toolCounts[call.tool_name] || 0) + 1;
          if (call.success) successCount++;
          if (call.duration_ms) totalDuration += call.duration_ms;
        });

        response.summary = {
          total_calls: data.length,
          success_rate: `${Math.round((successCount / data.length) * 100)}%`,
          average_duration_ms: Math.round(totalDuration / data.length),
          tool_breakdown: toolCounts
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }]
      };

    } catch (error) {
      throw new Error(`Supabase query failed: ${error.message}`);
    }
  }
}