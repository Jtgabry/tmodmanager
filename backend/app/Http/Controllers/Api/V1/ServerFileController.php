<?php

namespace App\Http\Controllers\Api\V1;

use App\Enums\ServerAbility;
use App\Http\Controllers\Controller;
use App\Http\Requests\UploadServerFileRequest;
use App\Services\Agent\AgentClient;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Log;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * File manager dei server. La sicurezza dei percorsi (niente "..", link verso fuori) la garantisce l'agent;
 * qui si controllano permessi e formato dei parametri.
 */
class ServerFileController extends Controller
{
    private const ROOT_RULE = ['required', 'string', 'regex:/^[a-z]{1,16}$/'];

    private const PATH_RULE = ['nullable', 'string', 'max:1024'];

    private const NAME_RULE = ['required', 'string', 'max:255'];

    public function __construct(private readonly AgentClient $agent) {}

    public function roots(string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Files]);

        return response()->json(['data' => $this->agent->json('get', "/servers/{$server}/files/roots")]);
    }

    public function index(Request $request, string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Files]);

        return response()->json(['data' => $this->agent->json('get', "/servers/{$server}/files", $this->location($request))]);
    }

    public function download(Request $request, string $server): StreamedResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Files]);

        return $this->agent->download("/servers/{$server}/files/download", null, $this->location($request));
    }

    public function upload(UploadServerFileRequest $request, string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Files]);

        $file = $request->file('file');
        $result = $this->agent->upload("/servers/{$server}/files/upload", $file->getRealPath(), [
            'root' => $request->validated('root'),
            'path' => (string) $request->validated('path'),
            'name' => $file->getClientOriginalName(),
            'overwrite' => $request->boolean('overwrite') ? '1' : '0',
        ]);

        $this->audit($request, $server, 'upload', $request->validated('path').'/'.$file->getClientOriginalName());

        return response()->json(['data' => $result], ($result['replaced'] ?? false) ? 200 : 201);
    }

    public function makeDirectory(Request $request, string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Files]);

        $data = $request->validate(['root' => self::ROOT_RULE, 'path' => self::PATH_RULE, 'name' => self::NAME_RULE]);

        return response()->json(['data' => $this->agent->json('post', "/servers/{$server}/files/mkdir", [
            'root' => $data['root'], 'path' => (string) ($data['path'] ?? ''), 'name' => $data['name'],
        ])], 201);
    }

    public function rename(Request $request, string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Files]);

        $data = $request->validate(['root' => self::ROOT_RULE, 'path' => ['required', 'string', 'max:1024'], 'name' => self::NAME_RULE]);
        $result = $this->agent->json('post', "/servers/{$server}/files/rename", $data);
        $this->audit($request, $server, 'rename', "{$data['path']} → {$data['name']}");

        return response()->json(['data' => $result]);
    }

    public function destroy(Request $request, string $server): Response
    {
        Gate::authorize('server', [$server, ServerAbility::Files]);

        $location = $this->location($request);
        $this->agent->json('delete', "/servers/{$server}/files", $location);
        $this->audit($request, $server, 'delete', $location['path']);

        return response()->noContent();
    }

    /**
     * @return array{root: string, path: string}
     */
    private function location(Request $request): array
    {
        $data = $request->validate(['root' => self::ROOT_RULE, 'path' => self::PATH_RULE]);

        return ['root' => $data['root'], 'path' => (string) ($data['path'] ?? '')];
    }

    private function audit(Request $request, string $server, string $action, string $path): void
    {
        Log::info('File manager', ['user' => $request->user()->email, 'server' => $server, 'action' => $action, 'path' => $path]);
    }
}
