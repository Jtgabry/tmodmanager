<?php

namespace App\Http\Requests\Admin;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class StoreServerRequest extends FormRequest
{
    /**
     * @return array<string, array<int, mixed>>
     */
    public function rules(): array
    {
        return [
            'id' => ['required', 'string', 'regex:/^[a-z0-9][a-z0-9-]{0,31}$/'],
            'name' => ['required', 'string', 'max:64'],
            'installDir' => ['required', 'string', 'max:255'],
            'port' => ['required', 'integer', 'min:1024', 'max:65535'],
            'maxPlayers' => ['required', 'integer', 'min:1', 'max:255'],
            'password' => ['nullable', 'string', 'max:64', 'regex:/^[^\r\n\x00]*$/'],
            'motd' => ['nullable', 'string', 'max:200', 'regex:/^[^\r\n\x00]*$/'],
            'world' => ['required', 'array'],
            'world.name' => ['required', 'string', "regex:/^[A-Za-z0-9 _'-]{1,40}$/"],
            'world.size' => ['required', 'integer', Rule::in([1, 2, 3])],
            'world.difficulty' => ['required', 'integer', Rule::in([0, 1, 2, 3])],
            'world.seed' => ['nullable', 'string', 'max:64', 'regex:/^[^\r\n\x00]*$/'],
            'copyModsFrom' => ['nullable', 'string', 'regex:/^[a-z0-9][a-z0-9-]{0,31}$/'],
        ];
    }

    /**
     * @return array<string, string>
     */
    public function messages(): array
    {
        return [
            'id.regex' => 'Solo lettere minuscole, numeri e trattini (max 32), senza trattino iniziale.',
            'world.name.regex' => 'Lettere, numeri, spazi, _ - \' (max 40).',
        ];
    }

    /**
     * Dati nel formato dell'agent.
     *
     * @return array<string, mixed>
     */
    public function payload(): array
    {
        $data = $this->validated();

        return [
            'id' => $data['id'],
            'name' => $data['name'],
            'installDir' => $data['installDir'],
            'port' => (int) $data['port'],
            'maxPlayers' => (int) $data['maxPlayers'],
            'password' => $data['password'] ?? '',
            'motd' => $data['motd'] ?? '',
            'world' => [
                'name' => trim($data['world']['name']),
                'size' => (int) $data['world']['size'],
                'difficulty' => (int) $data['world']['difficulty'],
                'seed' => $data['world']['seed'] ?? '',
            ],
            'copyModsFrom' => $data['copyModsFrom'] ?? null,
        ];
    }
}
