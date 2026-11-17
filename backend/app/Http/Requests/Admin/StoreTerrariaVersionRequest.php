<?php

namespace App\Http\Requests\Admin;

use Illuminate\Foundation\Http\FormRequest;

/**
 * Aggiunta di una versione fissa di Terraria (accanto all'installazione principale).
 */
class StoreTerrariaVersionRequest extends FormRequest
{
    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            'version' => ['required', 'string', 'regex:/^1(\.\d){3,5}$/'],
        ];
    }
}
