<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class UploadPluginRequest extends FormRequest
{
    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            // 100 MB (in KB). Che sia un assembly .NET lo controlla l'agent leggendo il file.
            'file' => ['required', 'file', 'extensions:dll', 'max:102400'],
            'enable' => ['sometimes', 'boolean'],
        ];
    }

    /**
     * @return array<string, string>
     */
    public function messages(): array
    {
        return [
            'file.extensions' => __('The file must be a .dll plugin.'),
            'file.uploaded' => __('Upload failed: the file exceeds the limit allowed by the server.'),
        ];
    }
}
