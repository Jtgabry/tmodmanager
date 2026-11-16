<?php

namespace App\Http\Controllers\Api\V1;

use App\Enums\ServerAbility;
use App\Http\Controllers\Controller;
use App\Services\Agent\AgentClient;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Log;

/**
 * Lettura e salvataggio dei file di testo (serverconfig.txt, config delle mod…) dall'editor del pannello.
 */
class ServerFileContentController extends Controller
{
    public function __construct(private readonly AgentClient $agent) {}

    public function show(Request $request, string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Files]);

        $data = $request->validate([
            'root' => ['required', 'string', 'regex:/^[a-z]{1,16}$/'],
            'path' => ['required', 'string', 'max:1024'],
        ]);

        return response()->json(['data' => $this->agent->json('get', "/servers/{$server}/files/content", $data)]);
    }

    public function update(Request $request, string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Files]);

        $data = $request->validate([
            'root' => ['required', 'string', 'regex:/^[a-z]{1,16}$/'],
            'path' => ['required', 'string', 'max:1024'],
            'content' => ['present', 'nullable', 'string', 'max:1048576'],
            'expectedModifiedAt' => ['nullable', 'string', 'max:40'],
        ]);
        $data['content'] = (string) $data['content'];

        $result = $this->agent->json('put', "/servers/{$server}/files/content", $data);
        Log::info('File manager', ['user' => $request->user()->email, 'server' => $server, 'action' => 'edit', 'path' => $data['path']]);

        return response()->json(['data' => $result]);
    }
}
