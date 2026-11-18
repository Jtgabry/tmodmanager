<?php

namespace App\Http\Requests\Admin;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * Passaggio guidato di un server tra Terraria vanilla e TShock.
 */
class SwitchServerGameRequest extends FormRequest
{
    /**
     * @return array<string, array<int, mixed>>
     */
    public function rules(): array
    {
        return [
            'game' => ['required', 'string', Rule::in(['terraria', 'tshock'])],
        ];
    }
}
