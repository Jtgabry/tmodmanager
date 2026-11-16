<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class UploadModRequest extends FormRequest
{
    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            // 1 GB (in KB). Il contenuto vero lo valida l'agent leggendo l'intestazione .tmod.
            'file' => ['required', 'file', 'extensions:tmod', 'max:1048576'],
            'enable' => ['sometimes', 'boolean'],
        ];
    }

    /**
     * @return array<string, string>
     */
    public function messages(): array
    {
        return [
            'file.extensions' => 'Il file deve essere una mod .tmod.',
            'file.uploaded' => 'Caricamento fallito: il file supera il limite consentito dal server.',
        ];
    }
}
