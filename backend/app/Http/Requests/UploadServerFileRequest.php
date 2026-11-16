<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class UploadServerFileRequest extends FormRequest
{
    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            'file' => ['required', 'file', 'max:1048576'],
            'root' => ['required', 'string', 'regex:/^[a-z]{1,16}$/'],
            'path' => ['nullable', 'string', 'max:1024'],
            'overwrite' => ['sometimes', 'boolean'],
        ];
    }

    /**
     * @return array<string, string>
     */
    public function messages(): array
    {
        return ['file.uploaded' => 'Caricamento fallito: il file supera il limite consentito dal server.'];
    }
}
