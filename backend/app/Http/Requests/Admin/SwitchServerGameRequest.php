<?php

namespace App\Http\Requests\Admin;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * Passaggio guidato di un server a un'altra installazione (installDir), a una versione fissa (game + version,
 * installata se manca) o a un altro gioco (game: Terraria all'ultima versione, TShock compatibile, tModLoader).
 */
class SwitchServerGameRequest extends FormRequest
{
    /**
     * @return array<string, array<int, mixed>>
     */
    public function rules(): array
    {
        return [
            'installDir' => ['required_without:game', 'prohibits:game', 'string', 'max:255'],
            'game' => ['required_without:installDir', 'string', Rule::in(['terraria', 'tshock', 'tmodloader'])],
            'version' => ['sometimes', 'string', 'regex:'.StoreInstallationVersionRequest::VERSION_PATTERN],
        ];
    }

    /**
     * @return array<string, string>
     */
    public function payload(): array
    {
        $data = $this->validated();

        return isset($data['installDir'])
            ? ['installDir' => $data['installDir']]
            : ['game' => $data['game'], ...(isset($data['version']) ? ['version' => $data['version']] : [])];
    }
}
