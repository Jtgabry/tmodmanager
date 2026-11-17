<?php

namespace App\Http\Requests\Admin;

use Illuminate\Foundation\Http\FormRequest;

class UpdateServerRequest extends FormRequest
{
    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            'name' => ['sometimes', 'string', 'max:64'],
            'port' => ['sometimes', 'integer', 'min:1024', 'max:65535'],
            'maxPlayers' => ['sometimes', 'integer', 'min:1', 'max:255'],
            // Assente = invariata; stringa vuota = nessuna password
            'password' => ['sometimes', 'nullable', 'string', 'max:64', 'regex:/^[^\r\n\x00]*$/'],
            'motd' => ['sometimes', 'nullable', 'string', 'max:200', 'regex:/^[^\r\n\x00]*$/'],
            // Cambio di versione: un'altra installazione, anche dell'altro gioco (Terraria ↔ tModLoader)
            'installDir' => ['sometimes', 'string', 'max:255'],
            // Altre chiavi di serverconfig.txt (l'agent sa quali e con che valori); null = toglie la chiave
            'config' => ['sometimes', 'array', 'max:64'],
            'config.*' => ['nullable', 'string', 'max:200', 'regex:/^[^\r\n\x00]*$/'],
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public function payload(): array
    {
        $data = $this->validated();

        foreach (['port', 'maxPlayers'] as $key) {
            if (array_key_exists($key, $data)) {
                $data[$key] = (int) $data[$key];
            }
        }
        foreach (['password', 'motd'] as $key) {
            if (array_key_exists($key, $data)) {
                $data[$key] ??= '';
            }
        }

        return $data;
    }
}
