import { useState, useCallback } from 'react';
import { supabase } from '../supabaseClient';
import { createSupabaseRetryWrapper } from '../utils/supabaseRetry';

export interface PhotoReportData {
  project_id: string;
  title: string;
  photos: Array<{
    url: string;
    path: string;
    caption: string;
  }>;
  date?: string;
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

export interface FileUploadResult {
  publicUrl: string;
  path: string;
  error?: string;
  base64Data?: string;
}

export const usePhotoReports = () => {
  const [isLoading, setIsLoading] = useState(false);
  const retryWrapper = createSupabaseRetryWrapper();

  /**
   * Конвертирует файл в base64 строку
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
   */
  const compressImage = async (file: File, maxWidth: number = 1920, maxHeight: number = 1080, quality: number = 0.8): Promise<File> => {
    return new Promise((resolve, reject) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const img = new Image();

      img.onload = () => {
        let { width, height } = img;
        
        if (width > maxWidth || height > maxHeight) {
          const ratio = Math.min(maxWidth / width, maxHeight / height);
          width *= ratio;
          height *= ratio;
        }

        canvas.width = width;
        canvas.height = height;

        ctx?.drawImage(img, 0, 0, width, height);

        canvas.toBlob(
          (blob) => {
            if (blob) {
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
   * Загружает файл в Supabase Storage
   */
  const uploadFile = async (bucketName: string, file: File): Promise<FileUploadResult> => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      throw new Error("User not authenticated for file upload");
    }

    const filePath = `${user.id}/${Date.now()}-${file.name}`;
    console.log(`Файлу присвоен путь: ${filePath}`);

    const { data: uploadData, error: uploadError } = await retryWrapper.storage(() =>
      supabase.storage
        .from(bucketName)
        .upload(filePath, file)
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
   * Загружает файл как base64 в базу данных
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
   * Загружает файл с fallback на base64 хранение
   */
  const uploadFileWithFallback = async (bucketName: string, file: File): Promise<FileUploadResult> => {
    try {
      // Сначала пробуем загрузить в Supabase Storage
      const storageResult = await uploadFile(bucketName, file);
      if (!storageResult.error) {
        return storageResult;
      }
      
      // Если ошибка, пробуем base64 fallback
      return await uploadFileAsBase64(file);
    } catch (error) {
      console.error('Ошибка при загрузке файла:', error);
      return await uploadFileAsBase64(file);
    }
  };

  /**
   * Создает запись фотоотчета в базе данных
   */
  const createPhotoReport = async (photoReportData: PhotoReportData): Promise<PhotoReportRecord> => {
    try {
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      
      if (authError) {
        console.error('Ошибка получения пользователя:', authError);
        throw new Error(`Ошибка авторизации: ${authError.message}`);
      }
      
      if (!user) {
        throw new Error('Пользователь не авторизован');
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
        throw error;
      }

      console.log('Фотоотчет успешно создан в БД:', data);
      return data as PhotoReportRecord;
    } catch (error) {
      console.error('Ошибка при создании фотоотчета:', error);
      throw error;
    }
  };

  /**
   * Главная функция для создания фотоотчета с загрузкой файлов
   */
  const createPhotoReportWithUploads = useCallback(async (data: {
    title: string;
    files: Array<{ file: File; caption: string }>;
    projectId: string;
    date?: string;
  }): Promise<PhotoReportRecord> => {
    setIsLoading(true);
    
    try {
      // Проверяем размер всех фотографий перед загрузкой
      const maxFileSize = 10 * 1024 * 1024; // 10MB
      const oversizedFiles = data.files.filter(item => item.file.size > maxFileSize);
      
      if (oversizedFiles.length > 0) {
        const fileSizeMB = (oversizedFiles[0].file.size / (1024 * 1024)).toFixed(2);
        throw new Error(`Файл "${oversizedFiles[0].file.name}" слишком большой: ${fileSizeMB}MB. Максимальный размер: 10MB`);
      }

      // Загружаем все фотографии с fallback на base64
      const uploadPromises = data.files.map(async (item, index) => {
        try {
          const uploadResult = await uploadFileWithFallback('photos', item.file);
          
          // Проверяем, что загрузка прошла успешно
          if (uploadResult.error) {
            throw new Error(`Ошибка загрузки фото "${item.file.name}": ${uploadResult.error}`);
          }
          
          // Проверяем, что у нас есть необходимые данные
          if (!uploadResult.publicUrl || !uploadResult.path) {
            throw new Error(`Неполные данные после загрузки фото "${item.file.name}": url=${uploadResult.publicUrl}, path=${uploadResult.path}`);
          }
          
          const photoData = {
            url: uploadResult.publicUrl,
            path: uploadResult.path,
            caption: item.caption.trim() || 'Без подписи',
            isBase64: uploadResult.path.startsWith('base64://')
          };
          
          console.log(`Фото ${index + 1} успешно загружено:`, photoData);
          return photoData;
        } catch (error) {
          console.error(`Ошибка загрузки фото ${index + 1} (${item.file.name}):`, error);
          throw error;
        }
      });

      const uploadedPhotosRes = await Promise.allSettled(uploadPromises);
      const uploadedPhotos = uploadedPhotosRes
        .filter((result): result is PromiseFulfilledResult<{ url: string; path: string; caption: string; isBase64: boolean; }> => result.status === 'fulfilled')
        .map(result => result.value);

      // Проверяем, есть ли файлы сохраненные как base64
      const base64Count = uploadedPhotos.filter(photo => photo.isBase64).length;
      if (base64Count > 0) {
        console.log(`Внимание: ${base64Count} фотографий сохранены как base64 из-за проблем с Storage`);
      }

      // Проверяем, что у нас есть загруженные фотографии
      if (uploadedPhotos.length === 0) {
        throw new Error('Не удалось загрузить ни одной фотографии');
      }

      // Логируем данные перед сохранением в БД
      const photoReportData: PhotoReportData = {
        project_id: data.projectId,
        title: data.title.trim(),
        photos: uploadedPhotos,
        date: data.date,
      };
      console.log('Данные для сохранения в БД:', photoReportData);

      // Создаем фотоотчет в базе данных
      const photoReportRecord = await createPhotoReport(photoReportData);

      return photoReportRecord;
    } finally {
      setIsLoading(false);
    }
  }, []);

  return {
    createPhotoReportWithUploads,
    isLoading,
  };
};
