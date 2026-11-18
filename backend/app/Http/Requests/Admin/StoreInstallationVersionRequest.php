<?php

namespace App\Http\Requests\Admin;

use Illuminate\Foundation\Http\FormRequest;

/**
 * Aggiunta di una versione fissa di Terraria, TShock o tModLoader (accanto all'installazione principale).
 */
class StoreInstallationVersionRequest extends FormRequest
{
    /** Numero di versione, usato anche come nome della cartella: 1.4.5.8, 6.2.1, 2026.09.3.1, 6.0.0-pre3. */
    public const VERSION_PATTERN = '/^\d[\w.-]{0,31}$/';

    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            'version' => ['required', 'string', 'regex:'.self::VERSION_PATTERN],
        ];
    }
}
