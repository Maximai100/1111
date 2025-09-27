import { useState, startTransition } from 'react';
import { supabase } from '../supabaseClient';
import { createSupabaseRetryWrapper } from '../utils/supabaseRetry';

export interface FileUploadResult {
  publicUrl: string;
  path: string;
  error?: string;
  base64Data?: string; // Для base64 хранения
}

export interface DocumentRecord {
  id: string;
  user_id: string;
  project_id?: string;
  name: string;
  file_url: string;
  storage_path: string;
  created_at: string;
  updated_at: string;
}

export interface PhotoReportRecord {
  id: string;
  user_id: string;
  project_id: string;
  title: string;
  photos: Array<{
    url: string;
    path: string;
    caption: string;
  }>;
  date: string;
  created_at: string;
  updated_at: string;
}

export const useFileStorage = () => {
  const [isUploading, setIsUploading] = useState(false);
  const retryWrapper = createSupabaseRetryWrapper();

  /**
   * Конвертирует файл в base64 строку
   * @param file - файл для конвертации
   * @returns base64 строка
   */
  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result);
        } else {
          reject(new Error('Ошибка конвертации файла в base64'));
        }
      };
      reader.onerror = () => reject(new Error('Ошибка чтения файла'));
      reader.readAsDataURL(file);
    });
  };

  /**
   * Сжимает изображение для уменьшения размера файла
   * @param file - файл изображения
   * @param maxWidth - максимальная ширина
   * @param maxHeight - максимальная высота
   * @param quality - качество сжатия (0-1)
   * @returns сжатый файл
   */
  const compressImage = async (file: File, maxWidth: number = 1920, maxHeight: number = 1080, quality: number = 0.8): Promise<File> => {
    return new Promise((resolve, reject) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const img = new Image();

      img.onload = () => {
        // Вычисляем новые размеры с сохранением пропорций
        let { width, height } = img;
        
        if (width > maxWidth || height > maxHeight) {
          const ratio = Math.min(maxWidth / width, maxHeight / height);
          width *= ratio;
          height *= ratio;
        }

        canvas.width = width;
        canvas.height = height;

        // Рисуем изображение на canvas
        ctx?.drawImage(img, 0, 0, width, height);

        // Конвертируем в blob
        canvas.toBlob(
          (blob) => {
            if (blob) {
              // Создаем новый файл с тем же именем
              const compressedFile = new File([blob], file.name, {
                type: file.type,
                lastModified: Date.now(),
              });
              resolve(compressedFile);
            } else {
              reject(new Error('Ошибка сжатия изображения'));
            }
          },
          file.type,
          quality
        );
      };

      img.onerror = () => reject(new Error('Ошибка загрузки изображения'));
      img.src = URL.createObjectURL(file);
    });
  };

  /**
   * Загружает файл с fallback на base64 хранение
   * @param bucketName - имя бакета ('documents' или 'photos')
   * @param file - файл для загрузки
   * @returns результат загрузки с публичным URL и путем
   */
  const uploadFileWithFallback = async (bucketName: string, file: File): Promise<FileUploadResult> => {
    return new Promise<FileUploadResult>((resolve, reject) => {
      startTransition(async () => {
        try {
          // Сначала пробуем загрузить в Supabase Storage
          const storageResult = await uploadFile(bucketName, file);
          if (!storageResult.error) {
            resolve(storageResult);
            return;
          }
          
          // Если ошибка, пробуем base64 fallback
          const base64Result = await uploadFileAsBase64(file);
          resolve(base64Result);
        } catch (error) {
          console.error('Ошибка при загрузке файла:', error);
          try {
            const base64Result = await uploadFileAsBase64(file);
            resolve(base64Result);
          } catch (fallbackError) {
            reject(fallbackError);
          }
        }
      });
    });
  };

  /**
   * Загружает файл как base64 в базу данных
   * @param file - файл для загрузки
   * @returns результат загрузки с base64 данными
   */
  const uploadFileAsBase64 = async (file: File): Promise<FileUploadResult> => {
    try {

      // Сжимаем изображение если нужно
      let fileToProcess = file;
      if (file.type.startsWith('image/') && file.size > 1 * 1024 * 1024) {
        try {
          const isWhatsAppImage = file.name.toLowerCase().includes('whatsapp');
          const quality = isWhatsAppImage ? 0.4 : 0.6;
          const maxWidth = isWhatsAppImage ? 1024 : 1280;
          const maxHeight = isWhatsAppImage ? 576 : 720;
          
          fileToProcess = await compressImage(file, maxWidth, maxHeight, quality);
        } catch (compressError) {
          console.warn('Ошибка сжатия для base64:', compressError);
        }
      }
      
      // Конвертируем в base64
      const base64Data = await fileToBase64(fileToProcess);
      
      // Создаем уникальный ID для файла
      const fileId = `${Date.now()}-${Math.random().toString(36).substring(2)}`;
      
      return {
        publicUrl: base64Data,
        path: `base64://${fileId}`,
        base64Data: base64Data
      };
    } catch (error) {
      console.error('Ошибка при загрузке файла как base64:', error);
      return { 
        publicUrl: '', 
        path: '', 
        error: error instanceof Error ? error.message : 'Ошибка загрузки файла' 
      };
    }
  };

  /**
   * Загружает файл в Supabase Storage
   * @param bucketName - имя бакета ('documents' или 'photos')
   * @param file - файл для загрузки
   * @returns результат загрузки с публичным URL и путем
   */
  const uploadFile = async (bucketName: string, file: File): Promise<FileUploadResult> => {

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      console.error("ОШИБКА: Пользователь не аутентифицирован для загрузки файла.");
      throw new Error("User not authenticated for file upload");
    }

    const filePath = `${user.id}/${Date.now()}-${file.name}`;
    console.log(`Файлу присвоен путь: ${filePath}`);

    // --- ЭТО ЕДИНСТВЕННО ПРАВИЛЬНЫЙ СПОСОБ ЗАГРУЗКИ ---
    const { data: uploadData, error: uploadError } = await retryWrapper.storage(() =>
      supabase.storage
        .from(bucketName)
        .upload(filePath, file) // Передаем сам ФАЙЛ, а не FormData
    );

    if (uploadError) {
      console.error("!!! ОШИБКА при загрузке в Storage:", uploadError);
      throw uploadError;
    }

    console.log("Файл успешно загружен. Получаем публичный URL...");

    const { data: urlData } = supabase.storage
      .from(bucketName)
      .getPublicUrl(uploadData.path);

    console.log("Успешно получен URL:", urlData.publicUrl);

    return {
      publicUrl: urlData.publicUrl,
      path: uploadData.path,
      error: undefined
    };
  };

  /**
   * Создает запись документа в базе данных
   * @param name - название документа
   * @param file_url - URL файла
   * @param storage_path - путь к файлу в Storage
   * @param project_id - ID проекта (null для глобальных документов)
   * @returns созданная запись или ошибка
   */
  const createDocument = async (
    name: string,
    file_url: string,
    storage_path: string,
    project_id: string | null
  ) => {

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      throw new Error('Пользователь не авторизован');
    }

    const insertData = {
      user_id: user.id, // <-- Ключевое исправление
      project_id: project_id,
      name: name,
      file_url: file_url,
      storage_path: storage_path,
    };

    const { data, error } = await supabase
      .from('documents')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      console.error('Ошибка при создании записи о документе:', error);
      throw error;
    }

    console.log("Запись о документе успешно создана:", data);
    return data;
  };

  /**
   * Создает запись фотоотчета в базе данных
   * @param photoReportData - данные фотоотчета
   * @returns созданная запись или ошибка
   */
  const createPhotoReport = async (photoReportData: {
    project_id: string;
    title: string;
    photos: Array<{
      url: string;
      path: string;
      caption: string;
    }>;
    date?: string;
  }) => {
    return new Promise<PhotoReportRecord>((resolve, reject) => {
      startTransition(async () => {
        try {
          const { data: { user }, error: authError } = await supabase.auth.getUser();
          
          if (authError) {
            console.error('Ошибка получения пользователя:', authError);
            reject(new Error(`Ошибка авторизации: ${authError.message}`));
            return;
          }
          
          if (!user) {
            reject(new Error('Пользователь не авторизован'));
            return;
          }

          // Логируем данные перед вставкой в БД
          const insertData = {
            user_id: user.id,
            project_id: photoReportData.project_id,
            title: photoReportData.title,
            photos: photoReportData.photos,
            date: photoReportData.date || new Date().toISOString(),
          };
          console.log('Вставляем в БД фотоотчет:', insertData);
          console.log('Массив photos:', JSON.stringify(insertData.photos, null, 2));

          const { data, error } = await retryWrapper.mutation(() =>
            supabase
              .from('photoreports')
              .insert(insertData)
              .select()
              .single()
          );

          if (error) {
            console.error('Ошибка создания фотоотчета:', error);
            reject(error);
            return;
          }

          console.log('Фотоотчет успешно создан в БД:', data);
          resolve(data as PhotoReportRecord);
        } catch (error) {
          console.error('Ошибка при создании фотоотчета:', error);
          reject(error);
        }
      });
    });
  };

  /**
   * Получает документы пользователя
   * @param projectId - опциональный ID проекта для фильтрации
   * @returns список документов
   */
  const getDocuments = async (projectId?: string) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        throw new Error('Пользователь не авторизован');
      }

      let query = supabase
        .from('documents')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (projectId) {
        query = query.eq('project_id', projectId);
      }

      const { data, error } = await query;

      if (error) {
        console.error('Ошибка получения документов:', error);
        throw error;
      }

      return data as DocumentRecord[];
    } catch (error) {
      console.error('Ошибка при получении документов:', error);
      throw error;
    }
  };

  /**
   * Получает фотоотчеты проекта
   * @param projectId - ID проекта
   * @returns список фотоотчетов
   */
  const getPhotoReports = async (projectId: string) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        throw new Error('Пользователь не авторизован');
      }

      const { data, error } = await retryWrapper.query(() =>
        supabase
          .from('photoreports')
          .select('*')
          .eq('user_id', user.id)
          .eq('project_id', projectId)
          .order('date', { ascending: false })
      );

      if (error) {
        console.error('Ошибка получения фотоотчетов:', error);
        throw error;
      }

      return data as PhotoReportRecord[];
    } catch (error) {
      console.error('Ошибка при получении фотоотчетов:', error);
      throw error;
    }
  };

  /**
   * Удаляет документ из базы данных и Storage
   * @param documentId - ID документа
   * @returns результат удаления
   */
  const deleteDocument = async (documentId: string) => {
    try {
      // Сначала получаем информацию о документе
      const { data: document, error: fetchError } = await supabase
        .from('documents')
        .select('storage_path')
        .eq('id', documentId)
        .single();

      if (fetchError) {
        throw fetchError;
      }

      // Удаляем файл из Storage
      const { error: storageError } = await supabase.storage
        .from('documents')
        .remove([document.storage_path]);

      if (storageError) {
        console.warn('Ошибка удаления файла из Storage:', storageError);
      }

      // Удаляем запись из базы данных
      const { error: dbError } = await supabase
        .from('documents')
        .delete()
        .eq('id', documentId);

      if (dbError) {
        throw dbError;
      }

      return true;
    } catch (error) {
      console.error('Ошибка при удалении документа:', error);
      throw error;
    }
  };

  /**
   * Удаляет фотоотчет из базы данных и все связанные файлы из Storage
   * @param photoReportId - ID фотоотчета
   * @returns результат удаления
   */
  const deletePhotoReport = async (photoReportId: string) => {
    try {
      // Сначала получаем информацию о фотоотчете
      const { data: photoReport, error: fetchError } = await supabase
        .from('photoreports')
        .select('photos')
        .eq('id', photoReportId)
        .single();

      if (fetchError) {
        throw fetchError;
      }

      // Удаляем все фотографии из Storage
      const pathsToDelete = photoReport.photos.map((photo: any) => photo.path);
      if (pathsToDelete.length > 0) {
        const { error: storageError } = await supabase.storage
          .from('photos')
          .remove(pathsToDelete);

        if (storageError) {
          console.warn('Ошибка удаления фотографий из Storage:', storageError);
        }
      }

      // Удаляем запись из базы данных
      const { error: dbError } = await supabase
        .from('photoreports')
        .delete()
        .eq('id', photoReportId);

      if (dbError) {
        throw dbError;
      }

      return true;
    } catch (error) {
      console.error('Ошибка при удалении фотоотчета:', error);
      throw error;
    }
  };

  return {
    isUploading,
    uploadFile,
    uploadFileWithFallback,
    uploadFileAsBase64,
    compressImage,
    fileToBase64,
    createDocument,
    createPhotoReport,
    getDocuments,
    getPhotoReports,
    deleteDocument,
    deletePhotoReport,
  };
};
