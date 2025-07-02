/**
 * FIXES FOR LANGFUSE TRACING INTEGRATION
 * 
 * Apply these changes to: editor-plugins/utils/open-ai-utils/src/main/ts/OpenAiUtils.ts
 */

// ===== FIX 1: Update enhancedOpenAiCompletion to include tracing =====

/**
 * Enhanced version of openAiCompletion with additional features
 * @param openAiService The OpenAI service API
 * @param options Enhanced options for the completion
 * @param preziOid Optional presentation ID
 * @param validateResult Optional function to validate the result
 * @param onTooManyRequestsOrInternalServerError Optional callback for too many requests or internal server error
 * @param onOpenAiParsingError Optional callback for parsing errors
 * @param onApiError Optional callback for API errors
 * @returns The completion result
 */
export async function enhancedOpenAiCompletion<T extends OpenAISuggestion>(
	openAiService: base.ServiceApi,
	options: Partial<EnhancedOpenAICompletionOptions>,
	preziOid?: string,
	validateResult?: (openAIResult: unknown) => openAIResult is T,
	onTooManyRequestsOrInternalServerError?: (retries: number) => void,
	onOpenAiParsingError?: (retries: number) => void,
	onApiError?: (retries: number) => void
): Promise<T> {
	// ===== NEW: Create Langfuse trace if tracing is enabled =====
	let traceId: string | null = null;
	if (isActive("js-langfuse-tracing") && options.tracingMetadata) {
		traceId = await createLangfuseTrace(openAiService, {
			name: options.tracingMetadata.traceName || "openai-completion",
			input: {
				systemPrompt: options.systemPrompt,
				userPrompt: options.userPrompt,
				model: options.model,
				functionDefinition: options.functionDefinition,
			},
			tags: options.tracingMetadata.tags || [],
			metadata: options.tracingMetadata.metadata || {},
		});
	}

	// Start timing for performance tracking
	const startTime = new Date();

	try {
		// Convert enhanced options to standard options
		const standardOptions: OpenAICompletionOptions = {
			retries: options.retries ?? 3,
			systemPrompt: options.systemPrompt ?? "Write professional, engaging presentations.",
			userPrompt: options.userPrompt ?? "",
			model: options.model ?? (isActive("js-ai-use-gpt4-mini") ? "gpt-4o-mini-2024-07-18" : "gpt-3.5-turbo"),
			max_tokens: options.max_tokens ?? 2000,
			seed: options.seed ?? null,
			temperature: options.temperature ?? null,
			promptName: options.promptName,
			promptVersion: options.promptVersion,
			functionDefinition: options.functionDefinition,
			tools: options.tools,
			tool_choice: options.tool_choice,
			parallel_tool_calls: options.parallel_tool_calls,
			response_format: options.response_format,
		};

		// Use the standard OpenAI completion function
		const result = await openAiCompletion<T>(
			openAiService,
			standardOptions,
			preziOid,
			validateResult,
			onTooManyRequestsOrInternalServerError,
			onOpenAiParsingError,
			onApiError
		);

		// ===== NEW: Record generation in Langfuse if tracing is enabled =====
		if (traceId && isActive("js-langfuse-tracing")) {
			const endTime = new Date();
			await recordLangfuseGeneration(openAiService, traceId, {
				name: options.tracingMetadata?.traceName || "openai-completion",
				model: standardOptions.model || "gpt-3.5-turbo",
				input: {
					systemPrompt: standardOptions.systemPrompt,
					userPrompt: standardOptions.userPrompt,
					functionDefinition: standardOptions.functionDefinition,
				},
				output: result,
				startTime,
				endTime,
				metadata: options.tracingMetadata?.metadata,
				modelParameters: {
					temperature: standardOptions.temperature,
					max_tokens: standardOptions.max_tokens,
				},
				usage: {
					// Note: standard openAiCompletion doesn't return usage info
					// This would need to be enhanced to capture actual usage
					inputTokens: 0,
					outputTokens: 0,
					totalTokens: 0,
				},
			});

			// Update trace with final output
			await updateLangfuseTrace(openAiService, traceId, result);
		}

		return result;
	} catch (error) {
		// ===== NEW: Update trace with error if tracing is enabled =====
		if (traceId && isActive("js-langfuse-tracing")) {
			await updateLangfuseTrace(openAiService, traceId, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		throw error;
	}
}

// ===== FIX 2: Update templateOpenAiCompletion to include tracing =====

/**
 * Helper function for template-based OpenAI completions - a simplified version of enhancedOpenAiCompletion
 * that assumes you want to use a template.
 */
export async function templateOpenAiCompletion<T extends OpenAISuggestion>(
	openAiService: base.ServiceApi,
	templateName: string,
	inputVariables: Record<string, any>,
	options: Partial<EnhancedOpenAICompletionOptions> = {},
	preziOid?: string,
	validateResult?: (openAIResult: unknown) => openAIResult is T
): Promise<T> {
	// ===== NEW: Create Langfuse trace if tracing is enabled =====
	let traceId: string | null = null;
	if (isActive("js-langfuse-tracing")) {
		traceId = await createLangfuseTrace(openAiService, {
			name: options.tracingMetadata?.traceName || templateName,
			input: {
				templateName,
				inputVariables,
			},
			tags: [...(options.tracingMetadata?.tags || []), "template"],
			metadata: {
				...options.tracingMetadata?.metadata,
				templateName,
			},
		});
	}

	// Start timing for performance tracking
	const startTime = new Date();

	try {
		// Create simplified template options
		const templateOptions: Partial<EnhancedOpenAICompletionOptions> = {
			...options,
			// Override with template settings
			templateInfo: {
				useTemplate: true,
				templateName,
				inputVariables,
			},
			// Set default traceName to the templateName if not provided
			tracingMetadata: {
				...options.tracingMetadata,
				traceName: options.tracingMetadata?.traceName || templateName,
			},
		};

		// Make the template service call directly instead of going through enhancedOpenAiCompletion
		// to avoid double tracing
		const response = await openAiService.access(
			"POST",
			["template", "run", templateName],
			{},
			{
				input_variables: inputVariables,
				metadata: {
					prezi_oid: preziOid,
				},
			}
		);

		// Parse the response
		const message = (response?.choices ?? [])[0]?.message;
		if (message == null) {
			throw new Error("No message in OpenAI response");
		}

		const functionCallArguments = message?.tool_calls?.[0]?.function?.arguments;
		if (functionCallArguments == null) {
			throw new Error("No function call arguments in OpenAI response");
		}

		const result = await tryToParseOpenAiText(
			functionCallArguments,
			validateResult
		);

		// ===== NEW: Record generation in Langfuse if tracing is enabled =====
		if (traceId && isActive("js-langfuse-tracing")) {
			const endTime = new Date();
			await recordLangfuseGeneration(openAiService, traceId, {
				name: templateName,
				model: "template-service",
				input: {
					templateName,
					inputVariables,
				},
				output: result,
				startTime,
				endTime,
				metadata: {
					...options.tracingMetadata?.metadata,
					templateName,
				},
				modelParameters: {},
				usage: response.usage || {},
			});

			// Update trace with final output
			await updateLangfuseTrace(openAiService, traceId, result);
		}

		return result;
	} catch (error) {
		// ===== NEW: Update trace with error if tracing is enabled =====
		if (traceId && isActive("js-langfuse-tracing")) {
			await updateLangfuseTrace(openAiService, traceId, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		throw error;
	}
}

// ===== FIX 3: Fix enhancedOpenAiCompletionWithFullResponse to call createDatasetRunItemIfNeeded =====

/**
 * Enhanced OpenAI completion that returns the full OpenAI response structure with Langfuse tracing
 */
export async function enhancedOpenAiCompletionWithFullResponse(
	openAiService: base.ServiceApi,
	conversationData: any,
	options: Partial<EnhancedOpenAICompletionOptions> = {},
	preziOid?: string,
	langfuseService?: any
): Promise<any> {
	// Start timing for performance tracking
	const startTime = new Date();

	// Create Langfuse trace if tracing is enabled and service is available
	let traceId: string | null = null;
	if (isActive("js-langfuse-tracing") && langfuseService && options.tracingMetadata) {
		try {
			traceId = await langfuseService.createTrace({
				name: options.tracingMetadata.traceName || "openai-completion-full-response",
				input: {
					messages: conversationData.messages,
					model: conversationData.model,
					functions: conversationData.functions,
					tools: conversationData.tools,
				},
				tags: options.tracingMetadata.tags || [],
				metadata: {
					...options.tracingMetadata.metadata,
					...getLangfuseDatasetMetadata(),
				},
			});

			// ===== NEW: Call createDatasetRunItemIfNeeded after creating trace =====
			if (traceId) {
				await createDatasetRunItemIfNeeded(langfuseService, traceId);
			}
		} catch (error) {
			console.error("Failed to create Langfuse trace:", error);
		}
	}

	try {
		// Apply default options
		const OpenAIDefaults = OPEN_AI_COMPLETIONS_DEFAULT_OPTIONS();
		const reqData = {
			model: options.model ?? OpenAIDefaults.model,
			max_tokens: options.max_tokens ?? OpenAIDefaults.max_tokens,
			response_format: OpenAIDefaults.response_format,
			temperature: options.temperature ?? null,
			...conversationData,
			metadata: {
				...(conversationData.metadata ?? {}),
				prezi_oid: preziOid,
			},
		};

		// Make the OpenAI service call
		const response = await openAiService.access(
			"POST",
			["chat", "completions"],
			{},
			reqData,
		);

		const endTime = new Date();

		// Record generation in Langfuse if tracing is enabled and service is available
		if (traceId && isActive("js-langfuse-tracing") && langfuseService) {
			try {
				await langfuseService.recordGeneration({
					traceId: traceId,
					name: options.tracingMetadata?.traceName || "openai-completion-full-response",
					model: reqData.model,
					input: {
						messages: conversationData.messages,
						functions: conversationData.functions,
						tools: conversationData.tools,
					},
					output: response,
					startTime,
					endTime,
					metadata: options.tracingMetadata?.metadata,
					modelParameters: {
						temperature: reqData.temperature,
						max_tokens: reqData.max_tokens,
					},
					usage: response.usage,
				});

				// Update trace with final output
				await langfuseService.updateTrace(traceId, response);
			} catch (error) {
				console.error("Failed to record Langfuse generation:", error);
			}
		}

		return response;
	} catch (error) {
		// If we have a trace, we should still try to record the error
		if (traceId && isActive("js-langfuse-tracing") && langfuseService) {
			try {
				await langfuseService.updateTrace(traceId, {
					error: error instanceof Error ? error.message : String(error),
				});
			} catch (traceError) {
				console.error("Failed to update Langfuse trace with error:", traceError);
			}
		}
		throw error;
	}
}
