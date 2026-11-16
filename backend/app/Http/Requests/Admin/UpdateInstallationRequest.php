<?php

namespace App\Http\Requests\Admin;

use Illuminate\Foundation\Http\FormRequest;

/**
 * Aggiornamento di un'installazione di tModLoader a una release (version) o ritorno a un backup (backup).
 */
class UpdateInstallationRequest extends FormRequest
{
    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            'version' => ['required_without:backup', 'prohibits:backup', 'string', 'regex:/^[\d.]{3,32}$/'],
            'backup' => ['required_without:version', 'string', 'max:500'],
            'restartServers' => ['sometimes', 'boolean'],
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public function payload(): array
    {
        $data = $this->validated();

        return [
            ...(isset($data['version']) ? ['version' => $data['version']] : ['backup' => $data['backup']]),
            'restartServers' => $this->boolean('restartServers', true),
        ];
    }
}
